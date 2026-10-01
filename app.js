(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Look. Dot color and radius come from the kepler.gl config the original RJ
  // map was made with (color [139,87,79], radius 3). kepler scales its radius
  // before drawing; 1/3 matches its rendered dot size, measured against the
  // reference screenshots. Radius is in CSS pixels.
  var DOT_COLOR = [139, 87, 79];
  var BASE_RADIUS = 3 / 3;
  var TILT = 50;
  var TILT_ZOOM_OUT = 0.45;
  var MAX_ZOOM = 15;

  // Zoom-driven light. A dot keeps its screen size while the points spread 2x
  // per zoom level, so how many dots pile onto one pixel, and therefore how
  // fast additive light burns to white, depends on the ABSOLUTE zoom, the same
  // over any city in any state. Keyframes tuned by eye on RJ (dense metro plus
  // sparse interior):
  //
  //   zoom   light   tamanho   what it should look like
  //   <= 3   0.08    0.60      the whole country (only BR zooms out this far):
  //                            bright coast, the interior a sprinkle of towns
  //      6   0.25    0.60      whole state: cities white, the interior a warm
  //                            sprinkle (lower light loses the small towns)
  //      8   0.06    0.50      from an airplane: hot cores, warm halos; any
  //                            more light and the metro burns into a blob
  //     10   0.20    0.40      the street grid shows through the glow
  //     13   2.00    0.35      each establishment a sharp street-lamp pinpoint
  //     15   2.50    0.35      same, isolated lamps
  //
  // light = opacidade * brilho, the per-dot alpha before additive blending.
  // Light is not monotonic: past the state view it dips so dense metros keep
  // their gradient, then climbs back as the dots separate. It is interpolated
  // geometrically (light is read as ratios, and density falls 4x per zoom
  // level); tamanho linearly, shrinking as you descend so
  // dots stay crisp instead of merging. Above 1 the light spills from
  // opacidade (capped at 1) into brilho.
  var ZOOM_KEYS = [
    { z: 3, light: 0.08, size: 0.6 },
    { z: 6, light: 0.25, size: 0.6 },
    { z: 8, light: 0.06, size: 0.5 },
    { z: 10, light: 0.2, size: 0.4 },
    { z: 13, light: 2.0, size: 0.35 },
    { z: 15, light: 2.5, size: 0.35 },
  ];

  var NAMES = {
    BR: "Brasil", AC: "Acre", AL: "Alagoas", AP: "Amapá", AM: "Amazonas", BA: "Bahia",
    CE: "Ceará", DF: "Distrito Federal", ES: "Espírito Santo", GO: "Goiás",
    MA: "Maranhão", MT: "Mato Grosso", MS: "Mato Grosso do Sul", MG: "Minas Gerais",
    PA: "Pará", PB: "Paraíba", PR: "Paraná", PE: "Pernambuco", PI: "Piauí",
    RJ: "Rio de Janeiro", RN: "Rio Grande do Norte", RS: "Rio Grande do Sul",
    RO: "Rondônia", RR: "Roraima", SC: "Santa Catarina", SP: "São Paulo",
    SE: "Sergipe", TO: "Tocantins",
  };

  // [column, row] in a 7x8 grid, roughly where each state sits on the map.
  var TILE_GRID = {
    RR: [1, 0], AP: [3, 0],
    AM: [1, 1], PA: [2, 1], MA: [3, 1], CE: [4, 1], RN: [5, 1],
    AC: [0, 2], RO: [1, 2], MT: [2, 2], TO: [3, 2], PI: [4, 2], PE: [5, 2], PB: [6, 2],
    GO: [3, 3], DF: [4, 3], BA: [5, 3], AL: [6, 3],
    MS: [2, 4], SP: [3, 4], MG: [4, 4], ES: [5, 4], SE: [6, 4],
    PR: [3, 5], RJ: [4, 5],
    SC: [3, 6],
    RS: [2, 7],
  };

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var fmt = function (n) { return n.toLocaleString("pt-BR"); };
  var $ = function (id) { return document.getElementById(id); };

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  // Light and dot size for an absolute zoom, from ZOOM_KEYS.
  function zoomCurve(z) {
    var k = ZOOM_KEYS;
    if (z <= k[0].z) return { light: k[0].light, size: k[0].size };
    for (var i = 1; i < k.length; i++) {
      if (z <= k[i].z) {
        var a = k[i - 1], b = k[i], t = (z - a.z) / (b.z - a.z);
        return {
          light: a.light * Math.pow(b.light / a.light, t),
          size: a.size + (b.size - a.size) * t,
        };
      }
    }
    var last = k[k.length - 1];
    return { light: last.light, size: last.size };
  }

  // ---------------------------------------------------------------------------
  // State

  var meta = null;
  var map = null;
  var points = null;       // the map layer that draws the dots
  var current = null;      // uf whose points are on screen
  var requested = null;    // uf the user last asked for
  var tilted = true;
  var fade = 1;            // 0..1 ramp applied to the gain when points arrive

  // Decoded point sets, so going back to a state is instant. Keeps the few
  // most recent; BR stays because it is the home view.
  var cache = new Map();
  var CACHE_MAX = 4;

  function remember(uf, data) {
    cache.delete(uf);
    cache.set(uf, data);
    while (cache.size > CACHE_MAX) {
      var oldest = null;
      cache.forEach(function (_, k) { if (!oldest && k !== "BR" && k !== uf) oldest = k; });
      if (!oldest) break;
      cache.delete(oldest);
      if (points) points.forget(oldest);
    }
  }

  // ---------------------------------------------------------------------------
  // Loading

  var worker = new Worker("worker.js");
  var nextId = 0;
  var pending = {};

  worker.onmessage = function (e) {
    var d = e.data;
    var p = pending[d.id];
    if (!p) return;
    if (d.progress !== undefined) { p.onProgress(d.progress); return; }
    delete pending[d.id];
    if (d.ok) p.resolve({ n: d.n, positions: d.positions, origin: d.origin });
    else p.reject(new Error(d.error));
  };

  function loadPoints(uf, onProgress) {
    if (cache.has(uf)) return Promise.resolve(cache.get(uf));
    // A new request supersedes any in flight (the worker aborts it).
    pending = {};
    var id = ++nextId;
    var url = new URL("data/" + uf.toLowerCase() + ".bin.gz", location.href).href;
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject, onProgress: onProgress };
      worker.postMessage({ id: id, url: url });
    }).then(function (pts) {
      var data = { uf: uf, n: pts.n, positions: pts.positions, origin: pts.origin };
      remember(uf, data);
      return data;
    });
  }

  function showProgress(label, frac) {
    $("progress").hidden = false;
    $("progress-fill").style.width = Math.round(frac * 100) + "%";
    $("progress-text").textContent = label + " " + Math.round(frac * 100) + "%";
  }

  function hideProgress() { $("progress").hidden = true; }

  // ---------------------------------------------------------------------------
  // Layer

  // The dots are drawn by a small MapLibre custom layer: one GL point per
  // establishment, straight into the map's own canvas. deck.gl's
  // ScatterplotLayer drew the same picture but ran at ~3 fps on SP's 3.3M dots
  // (an M4, Chrome); plain GL points draw it >10x faster.
  //
  // It reproduces ScatterplotLayer's dot exactly:
  // - a camera-facing disc of radius R CSS pixels (kepler's look; flat discs
  //   would smear into ellipses under the tilt),
  // - antialiased by smoothstep(d - 0.5, d + 0.5, R) on the distance d from the
  //   centre, also in CSS pixels, over a sprite padded by 0.5 px,
  // - color [139,87,79] with alpha = opacidade (rounded to 8 bits, as a vertex
  //   color was) * brilho (a float gain that can exceed 1),
  // - additive blending, SRC_ALPHA + ONE, on black: N stacked dots sum their
  //   light until the channel clamps to white. brilho therefore sets how many
  //   stacked dots it takes to reach white.
  //
  // Positions arrive from the worker as Web Mercator offsets from a per-file
  // origin, so float32 keeps sub-pixel precision at max zoom; the origin is
  // folded into the matrix in float64 here.
  var VS = [
    "attribute vec2 a_pos;",
    "uniform mat4 u_matrix;",
    "uniform float u_size;",
    "void main() {",
    "  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);",
    "  gl_PointSize = u_size;",
    "}",
  ].join("\n");

  var FS = [
    "precision mediump float;",
    "uniform vec4 u_color;",
    "uniform float u_radius;",   // R, CSS px
    "uniform float u_extent;",   // R + 0.5, the sprite's half-size in CSS px
    "void main() {",
    "  float d = length(gl_PointCoord * 2.0 - 1.0) * u_extent;",
    "  float a = smoothstep(d - 0.5, d + 0.5, u_radius);",
    "  gl_FragColor = vec4(u_color.rgb, u_color.a * a);",
    "}",
  ].join("\n");

  function createPointsLayer() {
    var gl = null, prog = null, loc = {};
    var buffers = new Map();       // uf -> GL buffer
    var data = null;
    var params = { alpha: 0.8, gain: 1, radius: BASE_RADIUS };

    function compile(type, src) {
      var sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      return sh;
    }

    function bufferFor(d) {
      var buf = buffers.get(d.uf);
      if (!buf) {
        buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, d.positions, gl.STATIC_DRAW);
        buffers.set(d.uf, buf);
      }
      return buf;
    }

    return {
      id: "pontos",
      type: "custom",
      renderingMode: "2d",

      onAdd: function (map, context) {
        gl = context;
        prog = gl.createProgram();
        gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
        gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
        ["a_pos"].forEach(function (k) { loc[k] = gl.getAttribLocation(prog, k); });
        ["u_matrix", "u_size", "u_color", "u_radius", "u_extent"].forEach(function (k) {
          loc[k] = gl.getUniformLocation(prog, k);
        });
      },

      render: function (gl, matrix) {
        if (!data) return;
        // matrix maps Mercator [0,1] to clip space; shift it to our origin.
        var ox = data.origin[0], oy = data.origin[1], m = new Float32Array(16);
        for (var i = 0; i < 16; i++) m[i] = matrix[i];
        for (var r = 0; r < 4; r++) m[12 + r] = matrix[r] * ox + matrix[4 + r] * oy + matrix[12 + r];

        var dpr = map.getPixelRatio ? map.getPixelRatio() : window.devicePixelRatio || 1;
        var R = params.radius, extent = R + 0.5;

        gl.useProgram(prog);
        gl.bindBuffer(gl.ARRAY_BUFFER, bufferFor(data));
        gl.enableVertexAttribArray(loc.a_pos);
        gl.vertexAttribPointer(loc.a_pos, 2, gl.FLOAT, false, 0, 0);
        gl.uniformMatrix4fv(loc.u_matrix, false, m);
        gl.uniform1f(loc.u_size, 2 * extent * dpr);
        gl.uniform1f(loc.u_radius, R);
        gl.uniform1f(loc.u_extent, extent);
        gl.uniform4f(loc.u_color, DOT_COLOR[0] / 255, DOT_COLOR[1] / 255, DOT_COLOR[2] / 255,
          (Math.round(255 * params.alpha) / 255) * params.gain);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.STENCIL_TEST);
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        gl.drawArrays(gl.POINTS, 0, data.n);
        gl.disableVertexAttribArray(loc.a_pos);
      },

      show: function (d) { data = d; map.triggerRepaint(); },

      set: function (alpha, gain, radius) {
        params.alpha = alpha;
        params.gain = gain;
        params.radius = radius;
        map.triggerRepaint();
      },

      forget: function (uf) {
        var buf = buffers.get(uf);
        if (buf && gl) gl.deleteBuffer(buf);
        buffers.delete(uf);
      },
    };
  }

  var knobs = ["opacity", "brightness", "dotsize"];

  function knobValue(name) { return parseFloat($(name).value); }

  function setKnob(name, v) {
    $(name).value = v;
    $(name + "-out").textContent = (+v).toFixed(2);
  }

  // The sliders are ABSOLUTE readouts-and-controls, not trims: the zoom curve
  // writes the computed values straight into the sliders, so the knobs slide
  // on their own as you zoom and their position *is* the current value.
  //
  // Dragging a slider overrides that value until the next zoom, which
  // re-asserts the curve — the cost of having the knobs track the zoom.
  //
  // fromZoom: recompute from the curve and push the values into the sliders.
  // Otherwise the user just dragged one, so read the sliders as-is.
  function apply(fromZoom) {
    if (!map) return;
    var z = map.getZoom();
    if (fromZoom) {
      var c = zoomCurve(z);
      var gain = clamp(c.light, 1, 2.5);
      setKnob("opacity", clamp(c.light / gain, 0.05, 1));
      setKnob("brightness", gain);
      setKnob("dotsize", c.size);
    }
    $("zoomval").textContent = z.toFixed(2);

    var data = current && cache.get(current);
    if (!data || !points) return;
    points.show(data);
    points.set(
      clamp(knobValue("opacity"), 0.05, 1),
      clamp(knobValue("brightness"), 0.02, 2.5) * fade,
      BASE_RADIUS * Math.max(knobValue("dotsize"), 0.1)
    );
  }

  // "zoom" fires many times per second during a wheel/pinch — coalesce to at
  // most one rebuild per animation frame.
  var frame = 0;
  var pendingZoom = false;
  function schedule(fromZoom) {
    if (fromZoom === true) pendingZoom = true;
    if (frame) return;
    frame = requestAnimationFrame(function () {
      frame = 0;
      var wasZoom = pendingZoom;
      pendingZoom = false;
      apply(wasZoom);
    });
  }

  // The lights come on: ramp the gain from 0 when a new point set lands.
  function lightUp() {
    if (reduceMotion) { fade = 1; schedule(false); return; }
    var start = performance.now();
    var DURATION = 1400;
    fade = 0;
    (function step(now) {
      var k = clamp((now - start) / DURATION, 0, 1);
      fade = k * k * (3 - 2 * k);
      apply(false);
      if (k < 1) requestAnimationFrame(step);
    })(start);
  }

  // ---------------------------------------------------------------------------
  // Camera

  function padding() {
    var small = window.innerWidth <= 640;
    if (small) return { top: 150, bottom: 70, left: 16, right: 16 };
    // Keep the place clear of the picker and the sliders: beside them on
    // landscape screens, between them on portrait ones.
    var picker = $("picker").getBoundingClientRect();
    var light = document.querySelector(".light").getBoundingClientRect();
    if (window.innerWidth > window.innerHeight) {
      return {
        top: 60,
        bottom: 40,
        left: Math.min(picker.width + 50, window.innerWidth * 0.3),
        right: Math.min(light.width + 50, window.innerWidth * 0.25),
      };
    }
    return { top: 280, bottom: picker.height + 50, left: 40, right: 40 };
  }

  function cameraFor(uf) {
    var b = meta[uf].bbox;
    var cam = map.cameraForBounds([[b[0], b[1]], [b[2], b[3]]], { padding: padding() });
    if (!cam) return { center: map.getCenter(), zoom: map.getZoom() };
    // cameraForBounds fits a top-down view; under the tilt the near edge of
    // the place widens on screen, so back off a little to keep it in frame.
    if (tilted) cam.zoom -= TILT_ZOOM_OUT;
    return cam;
  }

  // minZoom caps how far the user can zoom OUT, and is the bottom (t=0) of the
  // zoom curve. Same rule as the per-state pages had: 8, unless the place needs
  // less to fit (BR fits at ~3.7). Lowered first so the flight is not clamped,
  // then settled once the camera arrives.
  var settleMinZoom = null;

  function fly(uf) {
    var cam = cameraFor(uf);
    var target = Math.min(8, cam.zoom);
    map.setMinZoom(Math.min(map.getMinZoom(), target, map.getZoom()));
    if (settleMinZoom) map.off("moveend", settleMinZoom);
    settleMinZoom = function () {
      map.off("moveend", settleMinZoom);
      settleMinZoom = null;
      map.setMinZoom(target);
      schedule(true);
    };
    map.once("moveend", settleMinZoom);
    var opts = { center: cam.center, zoom: cam.zoom, pitch: tilted ? TILT : 0, bearing: 0 };
    if (reduceMotion) map.jumpTo(opts);
    else map.flyTo(Object.assign(opts, { duration: 2200, essential: true }));
  }

  // ---------------------------------------------------------------------------
  // Selecting a place

  function setReadout(uf) {
    var info = meta[uf];
    $("place").textContent = NAMES[uf] || uf;
    var pct = info.n_estab_ativos ? (info.n_estab_geolocalizados / info.n_estab_ativos) * 100 : 0;
    var html = "<b>" + fmt(info.n_estab_geolocalizados) + "</b> estabelecimentos no mapa<br>" +
      pct.toFixed(0) + "% dos " + fmt(info.n_estab_ativos) + " ativos";
    if (uf === "BR") html += "<br>vista com amostra de " + fmt(info.n_points) + " pontos";
    $("count").innerHTML = html;
    document.title = (uf === "BR" ? "brasiluminado" : (NAMES[uf] + " · brasiluminado"));
  }

  function markTiles(uf) {
    document.querySelectorAll(".tile[data-uf]").forEach(function (el) {
      el.setAttribute("aria-pressed", el.dataset.uf === uf ? "true" : "false");
    });
    $("picker-toggle-uf").textContent = uf;
  }

  function select(uf) {
    if (!meta[uf]) uf = "BR";
    if (uf === requested) return;
    requested = uf;
    markTiles(uf);
    setReadout(uf);
    var hash = uf === "BR" ? "" : "#" + uf.toLowerCase();
    if (location.hash !== hash) history.replaceState(null, "", hash || location.pathname + location.search);
    fly(uf);

    var label = "acendendo " + (uf === "BR" ? "o Brasil" : uf);
    var cached = cache.has(uf);
    if (!cached) showProgress(label, 0);
    loadPoints(uf, function (f) { if (requested === uf) showProgress(label, f); })
      .then(function () {
        if (requested !== uf) return;
        hideProgress();
        current = uf;
        apply(true);
        if (!cached) lightUp();
      })
      .catch(function (err) {
        if (requested !== uf) return;
        hideProgress();
        showError("Não foi possível carregar " + (NAMES[uf] || uf) + ": " + err.message + ". Recarregue a página para tentar de novo.");
      });
  }

  function fromHash() {
    var uf = location.hash.replace("#", "").toUpperCase();
    return meta[uf] ? uf : "BR";
  }

  function showError(msg) {
    $("error").textContent = msg;
    $("error").hidden = false;
  }

  // ---------------------------------------------------------------------------
  // UI

  function buildTiles() {
    var counts = Object.keys(meta).filter(function (k) { return k !== "BR"; })
      .map(function (k) { return meta[k].n_estab_geolocalizados; });
    var lo = Math.log(Math.min.apply(null, counts));
    var hi = Math.log(Math.max.apply(null, counts));
    var box = $("tiles");

    Object.keys(TILE_GRID).forEach(function (uf) {
      var pos = TILE_GRID[uf];
      var b = document.createElement("button");
      b.type = "button";
      b.className = "tile";
      b.textContent = uf;
      b.dataset.uf = uf;
      b.style.gridColumn = pos[0] + 1;
      b.style.gridRow = pos[1] + 1;
      var info = meta[uf];
      if (info) {
        var g = (Math.log(info.n_estab_geolocalizados) - lo) / (hi - lo || 1);
        b.style.setProperty("--glow", g.toFixed(3));
        b.setAttribute("aria-label", NAMES[uf] + ", " + fmt(info.n_estab_geolocalizados) + " estabelecimentos");
      } else {
        b.disabled = true;
        b.title = NAMES[uf] + ": sem dados ainda";
        b.setAttribute("aria-label", NAMES[uf] + ", sem dados ainda");
      }
      box.appendChild(b);
    });

    $("picker").addEventListener("click", function (e) {
      var t = e.target.closest(".tile[data-uf]");
      if (!t || t.disabled) return;
      select(t.dataset.uf);
      closePicker();
    });

    // Hover preview: the state's still render plus its numbers.
    var peek = $("peek");
    function showPeek(t) {
      var uf = t && t.dataset.uf;
      if (!uf || !meta[uf]) { peek.hidden = true; return; }
      $("peek-img").src = "thumbs/" + uf.toLowerCase() + ".png";
      $("peek-name").textContent = NAMES[uf];
      $("peek-stats").textContent = fmt(meta[uf].n_estab_geolocalizados) + " estabelecimentos";
      peek.hidden = false;
    }
    $("picker").addEventListener("pointerover", function (e) { showPeek(e.target.closest(".tile[data-uf]")); });
    $("picker").addEventListener("pointerleave", function () { peek.hidden = true; });
    $("picker").addEventListener("focusin", function (e) { showPeek(e.target.closest(".tile[data-uf]")); });
    $("picker").addEventListener("focusout", function () { peek.hidden = true; });
  }

  function closePicker() {
    $("picker").classList.remove("open");
    $("picker-toggle").setAttribute("aria-expanded", "false");
  }

  function wireUi() {
    $("picker-toggle").addEventListener("click", function () {
      var open = $("picker").classList.toggle("open");
      this.setAttribute("aria-expanded", open ? "true" : "false");
    });

    $("light-toggle").addEventListener("click", function () {
      var open = $("light-panel").classList.toggle("open");
      this.setAttribute("aria-expanded", open ? "true" : "false");
    });

    knobs.forEach(function (name) {
      $(name).addEventListener("input", function () {
        $(name + "-out").textContent = (+this.value).toFixed(2);
        schedule(false);
      });
    });

    $("tilt").addEventListener("click", function () {
      tilted = !tilted;
      this.setAttribute("aria-pressed", tilted ? "true" : "false");
      this.textContent = tilted ? "inclinada" : "de cima";
      map.easeTo({ pitch: tilted ? TILT : 0, bearing: tilted ? map.getBearing() : 0, duration: reduceMotion ? 0 : 900 });
    });

    $("about-open").addEventListener("click", function () { $("about").showModal(); });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        closePicker();
        $("light-panel").classList.remove("open");
        $("light-toggle").setAttribute("aria-expanded", "false");
      }
    });

    window.addEventListener("hashchange", function () { select(fromHash()); });
  }

  // ---------------------------------------------------------------------------
  // Boot

  function boot() {
    fetch("data/meta.json")
      .then(function (r) {
        if (!r.ok) throw new Error("meta.json " + r.status);
        return r.json();
      })
      .then(function (m) {
        meta = m;
        var sum = Object.keys(m).filter(function (k) { return k !== "BR"; })
          .reduce(function (a, k) { return a + m[k].n_points; }, 0);
        $("sum-points").textContent = fmt(sum);

        buildTiles();
        wireUi();

        var b = m.BR.bbox;
        map = new maplibregl.Map({
          container: "map",
          // No basemap: a black background, so only the dot cloud reads as signal.
          style: { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#000" } }] },
          bounds: [[b[0], b[1]], [b[2], b[3]]],
          fitBoundsOptions: { padding: padding() },
          minZoom: 2,
          maxZoom: MAX_ZOOM,
          pitch: TILT,
          antialias: false, // the dots antialias themselves; MSAA only costs fill
          attributionControl: false,
        });

        map.on("load", function () {
          points = createPointsLayer();
          map.addLayer(points);
          map.on("zoom", function () { schedule(true); });
          select(fromHash());
        });
      })
      .catch(function (err) {
        console.error(err);
        showError("Não foi possível carregar os dados (" + err.message + "). Recarregue a página para tentar de novo.");
      });
  }

  boot();
})();
