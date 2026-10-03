// Fetch + gunzip + parse a point file off the main thread, so the page stays
// responsive (progress keeps moving, the state grid stays clickable) while the
// biggest files (SP, MG, BR — millions of points) are being decoded.
//
// One long-lived worker serves every request. Each message carries an `id`;
// a newer request aborts the older one, so clicking through states quickly
// never leaves a stale download competing for bandwidth.
//
// File layout: see scripts/repack.py. After gunzip, a 32-byte header (magic
// "BLP3", u32 n, f64 lng0, f64 lat0, f64 q) then two blocks of n LEB128
// varints: zigzag deltas of the x and y grid indexes, in Morton order, then
// n bytes with the year each point's oldest establishment opened, minus 1900
// (files in the older "BLP2" layout stop after the varints and have no year).
// The .gz is served as a plain file (no Content-Encoding), so we gunzip it here.

var current = null;

self.onmessage = function (e) {
  var id = e.data.id;
  var url = e.data.url;
  if (current) current.abort();
  var controller = new AbortController();
  current = controller;

  fetch(url, { signal: controller.signal })
    .then(function (res) {
      if (!res.ok) throw new Error("fetch " + url + " -> " + res.status);
      var total = parseInt(res.headers.get("Content-Length"), 10) || 0;
      var loaded = 0;
      var lastPost = 0;
      // Older browsers (iOS < 16.4, Firefox < 113) have no DecompressionStream,
      // some no TransformStream: read the body whole and gunzip it in JS.
      if (typeof DecompressionStream === "undefined" || typeof TransformStream === "undefined" || !res.body) {
        return res.arrayBuffer().then(gunzip);
      }
      // Count compressed bytes as they arrive, before decompression, so the
      // progress fraction lines up with Content-Length.
      var counter = new TransformStream({
        transform: function (chunk, ctl) {
          loaded += chunk.byteLength;
          var now = Date.now();
          if (total && now - lastPost > 60) {
            lastPost = now;
            self.postMessage({ id: id, progress: loaded / total });
          }
          ctl.enqueue(chunk);
        },
      });
      var stream = res.body.pipeThrough(counter).pipeThrough(new DecompressionStream("gzip"));
      return new Response(stream).arrayBuffer();
    })
    .then(function (buf) {
      var out = decode(buf);
      if (current === controller) current = null;
      var boxes = chunkBoxes(out.positions, out.n, 2);
      // Points first, so the map lights up now; the merged levels follow.
      self.postMessage(
        {
          id: id, ok: true, n: out.n, positions: out.positions, origin: out.origin, q: out.q,
          years: out.years, hist: out.hist, hasYears: out.hasYears, boxes: boxes, chunk: CHUNK,
        },
        [out.positions.buffer, out.years.buffer, boxes.buffer]
      );
      var levels = buildLevels(out);
      var transfer = [];
      levels.forEach(function (l) { transfer.push(l.data.buffer, l.boxes.buffer); });
      self.postMessage({ id: id, levels: levels }, transfer);
    })
    .catch(function (err) {
      if (err.name === "AbortError") return;
      if (current === controller) current = null;
      self.postMessage({ id: id, ok: false, error: err.message });
    });
};

function gunzip(buf) {
  if (typeof fflate === "undefined") importScripts("https://unpkg.com/fflate@0.8.2/umd/index.js");
  var out = fflate.gunzipSync(new Uint8Array(buf));
  return out.byteOffset === 0 && out.byteLength === out.buffer.byteLength
    ? out.buffer
    : out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

// Web Mercator in MapLibre's [0,1] world units, as the map's custom-layer
// matrix expects.
function mercX(lng) { return (lng + 180) / 360; }
function mercY(lat) {
  var s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

// y is not linear in latitude, and sin+log per point was most of the decode
// time on SP. Mercator y is smooth, so a table every 64 grid units (~70 m)
// with linear interpolation is exact to ~1e-11, far below a pixel.
var TABLE_STEP = 64;

function mercTable(lat0, q, max, oy) {
  var size = Math.floor(max / TABLE_STEP) + 2;
  var t = new Float64Array(size);
  for (var j = 0; j < size; j++) t[j] = mercY(lat0 + j * TABLE_STEP * q) - oy;
  return t;
}

function lookup(t, gi) {
  var j = (gi / TABLE_STEP) | 0;
  var f = gi / TABLE_STEP - j;
  return t[j] + (t[j + 1] - t[j]) * f;
}

// Decodes straight into the GPU-ready buffer: interleaved [x,y,...] as
// Mercator offsets from the grid origin. Offsets keep float32 precise (a
// state spans ~0.03 world units, so float32 resolves well under a pixel at
// zoom 15); absolute coordinates would not.
function decode(buf) {
  var head = new DataView(buf, 0, 32);
  var magic = String.fromCharCode(head.getUint8(0), head.getUint8(1), head.getUint8(2), head.getUint8(3));
  if (magic !== "BLP2" && magic !== "BLP3") throw new Error("formato de dados desconhecido");
  var n = head.getUint32(4, true);
  var lng0 = head.getFloat64(8, true);
  var lat0 = head.getFloat64(16, true);
  var q = head.getFloat64(24, true);
  var ox = mercX(lng0), oy = mercY(lat0);
  var bytes = new Uint8Array(buf, 32);
  var positions = new Float32Array(n * 2);
  var grid = [new Int32Array(n), new Int32Array(n)]; // integer grid x, y for the levels
  var p = 0;

  for (var axis = 0; axis < 2; axis++) {
    var acc = 0, max = 0;
    var g = grid[axis];
    for (var i = 0; i < n; i++) {
      // LEB128; grid indexes fit well inside 2^31, so 32-bit math is safe.
      var b = bytes[p++];
      var v = b & 0x7f;
      var shift = 7;
      while (b & 0x80) {
        b = bytes[p++];
        v |= (b & 0x7f) << shift;
        shift += 7;
      }
      acc += (v >>> 1) ^ -(v & 1); // un-zigzag
      g[i] = acc;
      if (acc > max) max = acc;
    }
    if (axis === 0) {
      var sx = q / 360;                   // x is linear in longitude
      for (i = 0; i < n; i++) positions[i * 2] = g[i] * sx;
    } else {
      var table = mercTable(lat0, q, max, oy);
      for (i = 0; i < n; i++) positions[i * 2 + 1] = lookup(table, g[i]);
    }
  }
  // BLP2 has no years: everything counts as opened in 1900, so it is always lit.
  var hasYears = magic === "BLP3";
  var years = new Uint8Array(n);
  var hist = new Uint32Array(256);
  if (hasYears) {
    years.set(bytes.subarray(p, p + n));
    for (i = 0; i < n; i++) hist[years[i]]++;
  }
  return {
    n: n, positions: positions, origin: [ox, oy], q: q,
    years: years, hist: hist, hasYears: hasYears,
    yTable: table, gx: grid[0], gy: grid[1],
  };
}

// Culling. Zoomed in, most of a state is off screen, yet every point would
// still run the vertex shader each frame (3.3M on SP, every frame while the
// lights twinkle). Points are in Morton order, so CHUNK consecutive points
// cover a compact patch of ground: the bounding box of each chunk, as
// [minx, miny, maxx, maxy] in the same Mercator offsets as the points, lets
// the layer draw only the runs of chunks that reach the screen.
var CHUNK = 8192;

function chunkBoxes(data, n, stride) {
  var count = Math.ceil(n / CHUNK);
  var boxes = new Float32Array(count * 4);
  for (var c = 0; c < count; c++) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    var end = Math.min(n, (c + 1) * CHUNK) * stride;
    for (var o = c * CHUNK * stride; o < end; o += stride) {
      var x = data[o], y = data[o + 1];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    boxes[c * 4] = x0; boxes[c * 4 + 1] = y0; boxes[c * 4 + 2] = x1; boxes[c * 4 + 3] = y1;
  }
  return boxes;
}

// Level of detail for far zooms, where hundreds of dots land on one pixel and
// blending each of them separately is what makes the frame slow.
//
// Level k merges every point inside one 2^k x 2^k cell of the grid into a
// single dot at their centroid, carrying the count. The layer draws it with
// count times the light, which is what the stacked dots would have summed to
// (additive blending is linear and clamps to white the same way), and only
// switches to a level whose cells are a fraction of a device pixel, so the
// picture does not change.
//
// Points are in Morton order, so the points of a cell are contiguous at every
// level: each level is one linear pass over the previous one.
//
var LEVEL_FIRST = 6;  // finer cells merge too little to be worth a level
var LEVEL_STEP = 2;   // then cells grow 4x per side each level

function buildLevels(pts) {
  var levels = [];
  var n = pts.n, q = pts.q;
  var yTable = pts.yTable;
  var ix = pts.gx, iy = pts.gy, cnt = null;     // input: raw points, count 1
  var sx0 = null, sy0 = null;                   // input sums of grid coords
  for (var k = LEVEL_FIRST, shift = LEVEL_FIRST; k <= 24; k += LEVEL_STEP, shift = LEVEL_STEP) {
    var cxs = new Int32Array(n), cys = new Int32Array(n);
    var sumx = new Float64Array(n), sumy = new Float64Array(n), cs = new Float32Array(n);
    var m = 0, i = 0;
    while (i < n) {
      var cx = ix[i] >> shift, cy = iy[i] >> shift;
      var sx = 0, sy = 0, c = 0;
      do {
        if (cnt === null) { sx += ix[i]; sy += iy[i]; c += 1; }
        else { sx += sx0[i]; sy += sy0[i]; c += cnt[i]; }
        i++;
      } while (i < n && ix[i] >> shift === cx && iy[i] >> shift === cy);
      cxs[m] = cx; cys[m] = cy; sumx[m] = sx; sumy[m] = sy; cs[m] = c;
      m++;
    }
    // Centroid in grid units -> Mercator offsets, like decode() does.
    var data = new Float32Array(m * 3);
    for (var j = 0; j < m; j++) {
      data[j * 3] = (sumx[j] / cs[j]) * q / 360;
      data[j * 3 + 1] = lookup(yTable, sumy[j] / cs[j]);
      data[j * 3 + 2] = cs[j];
    }
    levels.push({ k: k, n: m, data: data, boxes: chunkBoxes(data, m, 3) });
    if (m < 2000) break;
    ix = cxs.subarray(0, m); iy = cys.subarray(0, m);
    sx0 = sumx; sy0 = sumy; cnt = cs; n = m;
  }
  return levels;
}
