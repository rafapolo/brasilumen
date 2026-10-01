// Fetch + gunzip + parse a point file off the main thread, so the page stays
// responsive (progress keeps moving, the state grid stays clickable) while the
// biggest files (SP, MG, BR — millions of points) are being decoded.
//
// One long-lived worker serves every request. Each message carries an `id`;
// a newer request aborts the older one, so clicking through states quickly
// never leaves a stale download competing for bandwidth.
//
// File layout (struct-of-arrays, written by the extractor's write_points_soa):
// n lngs (f32), then n lats (f32), then n weights (u16). The .gz is served as
// a plain file (no Content-Encoding), so we decompress it ourselves.

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
      var n = (buf.byteLength / 10) | 0;
      var lngs = new Float32Array(buf, 0, n);
      var lats = new Float32Array(buf, 4 * n, n);
      // deck.gl's ScatterplotLayer wants one interleaved [lng,lat,...] buffer.
      var positions = new Float32Array(n * 2);
      for (var i = 0; i < n; i++) {
        positions[i * 2] = lngs[i];
        positions[i * 2 + 1] = lats[i];
      }
      if (current === controller) current = null;
      self.postMessage({ id: id, ok: true, n: n, positions: positions }, [positions.buffer]);
    })
    .catch(function (err) {
      if (err.name === "AbortError") return;
      if (current === controller) current = null;
      self.postMessage({ id: id, ok: false, error: err.message });
    });
};
