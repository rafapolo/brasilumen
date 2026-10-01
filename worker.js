// Fetch + gunzip + parse a point file off the main thread, so the page stays
// responsive (progress keeps moving, the state grid stays clickable) while the
// biggest files (SP, MG, BR — millions of points) are being decoded.
//
// One long-lived worker serves every request. Each message carries an `id`;
// a newer request aborts the older one, so clicking through states quickly
// never leaves a stale download competing for bandwidth.
//
// File layout: see scripts/repack.py. After gunzip, a 32-byte header (magic
// "BLP2", u32 n, f64 lng0, f64 lat0, f64 q) then two blocks of n LEB128
// varints: zigzag deltas of the x and y grid indexes, in Morton order. The
// .gz is served as a plain file (no Content-Encoding), so we gunzip it here.

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
      self.postMessage(
        { id: id, ok: true, n: out.positions.length / 2, positions: out.positions, origin: out.origin },
        [out.positions.buffer]
      );
    })
    .catch(function (err) {
      if (err.name === "AbortError") return;
      if (current === controller) current = null;
      self.postMessage({ id: id, ok: false, error: err.message });
    });
};

// Web Mercator in MapLibre's [0,1] world units, as the map's custom-layer
// matrix expects.
function mercX(lng) { return (lng + 180) / 360; }
function mercY(lat) {
  var s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

// Decodes straight into the GPU-ready buffer: interleaved [x,y,...] as
// Mercator offsets from the grid origin. Offsets keep float32 precise (a
// state spans ~0.03 world units, so float32 resolves well under a pixel at
// zoom 15); absolute coordinates would not.
function decode(buf) {
  var head = new DataView(buf, 0, 32);
  var magic = String.fromCharCode(head.getUint8(0), head.getUint8(1), head.getUint8(2), head.getUint8(3));
  if (magic !== "BLP2") throw new Error("formato de dados desconhecido");
  var n = head.getUint32(4, true);
  var lng0 = head.getFloat64(8, true);
  var lat0 = head.getFloat64(16, true);
  var q = head.getFloat64(24, true);
  var ox = mercX(lng0), oy = mercY(lat0);
  var bytes = new Uint8Array(buf, 32);
  var positions = new Float32Array(n * 2);
  var p = 0;

  for (var axis = 0; axis < 2; axis++) {
    var acc = 0;
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
      positions[i * 2 + axis] = axis === 0
        ? (acc * q) / 360                 // x is linear in longitude
        : mercY(lat0 + acc * q) - oy;     // y is not
    }
  }
  return { positions: positions, origin: [ox, oy] };
}
