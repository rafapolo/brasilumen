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
  // light sets opacidade (capped at 1); the per-dot alpha before additive
  // blending is opacidade * brilho, and brilho has its own curve (BRIGHT_KEYS).
  // Light is not monotonic: past the state view it dips so dense metros keep
  // their gradient, then climbs back as the dots separate. It is interpolated
  // geometrically (light is read as ratios, and density falls 4x per zoom
  // level); tamanho linearly, shrinking as you descend so
  // dots stay crisp instead of merging.
  var ZOOM_KEYS = [
    { z: 3, light: 0.08, size: 0.6 },
    { z: 6, light: 0.25, size: 0.6 },
    { z: 8, light: 0.06, size: 0.5 },
    { z: 10, light: 0.2, size: 0.4 },
    { z: 13, light: 2.0, size: 0.35 },
    { z: 15, light: 2.5, size: 0.35 },
  ];

  // brilho has its own curve, independent of light: nearly off from afar
  // (<= 4), waking through the state view (7) and at least 2 from 8 down.
  // opacidade still follows light (capped at 1).
  var BRIGHT_KEYS = [
    { z: 4, v: 0.04 },
    { z: 7, v: 0.6 },
    { z: 8, v: 2.0 },
    { z: 15, v: 2.5 },
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

  // brilho for an absolute zoom, from BRIGHT_KEYS, interpolated geometrically.
  function brightCurve(z) {
    var k = BRIGHT_KEYS;
    if (z <= k[0].z) return k[0].v;
    for (var i = 1; i < k.length; i++) {
      if (z <= k[i].z) {
        var a = k[i - 1], b = k[i];
        return a.v * Math.pow(b.v / a.v, (z - a.z) / (b.z - a.z));
      }
    }
    return k[k.length - 1].v;
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
  var fadeFrom = null;     // uf whose points fade out as `current` fades in

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

  // Versioned so a cached worker never pairs with a newer app.js (GitHub
  // Pages caches for 10 min). Bump together with the ?v= in index.html.
  var worker = new Worker("worker.js?v=4");
  var nextId = 0;
  var pending = {};

  var levelsFor = {};   // request id -> uf, for the levels that follow the points

  worker.onmessage = function (e) {
    var d = e.data;
    if (d.levels) {
      var target = cache.get(levelsFor[d.id]);
      delete levelsFor[d.id];
      if (target) {
        target.levels = d.levels;
        if (points) points.refresh();
      }
      return;
    }
    var p = pending[d.id];
    if (!p) return;
    if (d.progress !== undefined) { p.onProgress(d.progress); return; }
    delete pending[d.id];
    if (d.ok) p.resolve({ id: d.id, n: d.n, positions: d.positions, origin: d.origin, q: d.q });
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
      var data = { uf: uf, n: pts.n, positions: pts.positions, origin: pts.origin, q: pts.q, levels: [] };
      remember(uf, data);
      levelsFor[pts.id] = uf;
      return data;
    });
  }

  // The loader stays up for the whole change of place, flight included, and
  // fades out as the place's lights come on. frac null means nothing to
  // download (the place is cached), so the bar sweeps instead of filling.
  var progressTimer = 0;

  function showProgress(label, frac) {
    var el = $("progress");
    clearTimeout(progressTimer);
    el.hidden = false;
    el.classList.remove("out");
    el.classList.toggle("busy", frac === null);
    $("progress-fill").style.width = frac === null ? "" : Math.round(frac * 100) + "%";
    $("progress-text").textContent = frac === null ? label : label + " " + Math.round(frac * 100) + "%";
  }

  function hideProgress(now) {
    var el = $("progress");
    clearTimeout(progressTimer);
    if (now || reduceMotion) { el.hidden = true; return; }
    el.classList.add("out");
    progressTimer = setTimeout(function () { el.hidden = true; }, 700);
  }

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
  //
  // Far out, hundreds of dots land on one pixel and blending each of them is
  // what costs the frame. The worker therefore also sends merged levels: every
  // point in a grid cell becomes one dot carrying the count (see worker.js).
  // The layer picks the coarsest level whose cells stay under LOD_MAX_PX of a
  // device pixel, and draws a merged dot with count times the light: additive
  // blending is linear and clamps to white the same way, so the picture is
  // the same as drawing every dot. Hence the premultiplied form below,
  // rgb * min(1, light * coverage) * count with blend ONE + ONE, which equals
  // the old SRC_ALPHA + ONE with alpha = light * coverage for a single dot.
  var LOD_MAX_PX = 0.3;

  // Twinkle: the light drifts around its value, by up to TWINKLE of it, on a
  // phase and period (about 1 to 2.5 s) of its own, like city lights seen
  // from a plane. The phase belongs to the ground cell a dot falls in, about
  // TWINKLE_PX CSS pixels wide at the current zoom level, not to the dot:
  // dots stacked on one pixel would otherwise average their twinkles away.
  // Where the stack is far past white it still hides. It keeps the map
  // repainting every frame, so it is off under reduced motion.
  var TWINKLE_PX = 2;
  var TWINKLE = reduceMotion ? 0 : 0.85;

  var VS = [
    "attribute vec2 a_pos;",
    "attribute float a_count;",
    "uniform mat4 u_matrix;",
    "uniform float u_size;",
    "uniform float u_time;",     // seconds
    "uniform float u_twinkle;",
    "uniform float u_cell;",     // twinkle cell, in Mercator units
    "varying float v_count;",
    "float hash(vec2 p) {",
    "  vec3 q = fract(vec3(p.xyx) * 0.1031);",
    "  q += dot(q, q.yzx + 33.33);",
    "  return fract((q.x + q.y) * q.z);",
    "}",
    "void main() {",
    "  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);",
    "  gl_PointSize = u_size;",
    // Two unrelated numbers per cell: phase and pace.
    "  vec2 cell = floor(a_pos / u_cell);",
    "  float h = hash(cell);",
    "  float g = hash(cell + 71.3);",
    "  float w = 2.5 + 4.0 * g;",
    "  float tw = 1.0 + u_twinkle * sin(u_time * w + 6.2832 * h) * (0.7 + 0.3 * sin(u_time * w * 0.31 + 6.2832 * g));",
    "  v_count = min(a_count, 60000.0) * tw;",  // stays finite in mediump; white long before
    "}",
  ].join("\n");

  var FS = [
    "#ifdef GL_FRAGMENT_PRECISION_HIGH",
    "precision highp float;",
    "#else",
    "precision mediump float;",
    "#endif",
    "uniform vec3 u_rgb;",
    "uniform float u_light;",    // opacidade * brilho
    "uniform float u_radius;",   // R, CSS px
    "uniform float u_extent;",   // R + 0.5, the sprite's half-size in CSS px
    "varying float v_count;",
    "void main() {",
    "  float d = length(gl_PointCoord * 2.0 - 1.0) * u_extent;",
    "  float cover = smoothstep(d - 0.5, d + 0.5, u_radius);",
    "  gl_FragColor = vec4(u_rgb * min(1.0, u_light * cover) * v_count, 1.0);",
    "}",
  ].join("\n");

  function createPointsLayer() {
    var gl = null, prog = null, loc = {};
    var buffers = new Map();       // uf + level -> GL buffer
    var data = null, prev = null;  // prev fades out under data, see lightUp
    var mix = 1;                   // data's share of the light; prev gets 1 - mix
    var params = { alpha: 0.8, gain: 1, radius: BASE_RADIUS };

    function compile(type, src) {
      var sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      return sh;
    }

    function bufferFor(key, array) {
      var buf = buffers.get(key);
      if (!buf) {
        buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, array, gl.STATIC_DRAW);
        buffers.set(key, buf);
      }
      return buf;
    }

    // Coarsest level whose cells stay under LOD_MAX_PX device pixels where the
    // map is closest to the camera. A cell is 2^k grid steps of q degrees; one
    // degree of latitude is up to ~1.25x a degree of longitude in Mercator
    // over Brazil, and under the tilt the bottom of the screen is magnified
    // up to ~1 + pitch/45 against the centre.
    function pickLevel(d, zoom, dpr, pitch) {
      var pxWorld = 1 / (512 * Math.pow(2, zoom) * dpr);
      var limit = (LOD_MAX_PX * pxWorld) / (1.25 * (1 + pitch / 45));
      var best = null;
      for (var i = 0; i < d.levels.length; i++) {
        if ((Math.pow(2, d.levels[i].k) * d.q) / 360 <= limit) best = d.levels[i];
      }
      return best;
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
        ["a_pos", "a_count"].forEach(function (k) { loc[k] = gl.getAttribLocation(prog, k); });
        ["u_matrix", "u_size", "u_rgb", "u_light", "u_radius", "u_extent", "u_time", "u_twinkle", "u_cell"].forEach(function (k) {
          loc[k] = gl.getUniformLocation(prog, k);
        });
      },

      render: function (gl, matrix) {
        if (!data) return;
        var dpr = map.getPixelRatio ? map.getPixelRatio() : window.devicePixelRatio || 1;
        var R = params.radius, extent = R + 0.5;
        var light = (Math.round(255 * params.alpha) / 255) * params.gain;

        gl.useProgram(prog);
        gl.uniform1f(loc.u_size, 2 * extent * dpr);
        gl.uniform1f(loc.u_radius, R);
        gl.uniform1f(loc.u_extent, extent);
        gl.uniform1f(loc.u_time, (performance.now() / 1000) % 3600);
        gl.uniform1f(loc.u_twinkle, TWINKLE);
        gl.uniform1f(loc.u_cell, TWINKLE_PX / (512 * Math.pow(2, Math.floor(map.getZoom()))));
        gl.uniform3f(loc.u_rgb, DOT_COLOR[0] / 255, DOT_COLOR[1] / 255, DOT_COLOR[2] / 255);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.STENCIL_TEST);
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.ONE, gl.ONE);
        // Additive light: the two sets of a crossfade simply sum.
        if (prev && prev !== data && mix < 1) draw(prev, light * (1 - mix));
        draw(data, light * mix);
        gl.disableVertexAttribArray(loc.a_pos);
        gl.disableVertexAttribArray(loc.a_count);
        if (TWINKLE) map.triggerRepaint();

        function draw(d, l) {
          // matrix maps Mercator [0,1] to clip space; shift it to d's origin.
          var ox = d.origin[0], oy = d.origin[1], m = new Float32Array(16);
          for (var i = 0; i < 16; i++) m[i] = matrix[i];
          for (var r = 0; r < 4; r++) m[12 + r] = matrix[r] * ox + matrix[4 + r] * oy + matrix[12 + r];
          var level = pickLevel(d, map.getZoom(), dpr, map.getPitch());

          gl.enableVertexAttribArray(loc.a_pos);
          if (level) {
            gl.bindBuffer(gl.ARRAY_BUFFER, bufferFor(d.uf + ":" + level.k, level.data));
            gl.vertexAttribPointer(loc.a_pos, 2, gl.FLOAT, false, 12, 0);
            gl.enableVertexAttribArray(loc.a_count);
            gl.vertexAttribPointer(loc.a_count, 1, gl.FLOAT, false, 12, 8);
          } else {
            gl.bindBuffer(gl.ARRAY_BUFFER, bufferFor(d.uf, d.positions));
            gl.vertexAttribPointer(loc.a_pos, 2, gl.FLOAT, false, 0, 0);
            gl.disableVertexAttribArray(loc.a_count);
            gl.vertexAttrib1f(loc.a_count, 1);
          }
          gl.uniformMatrix4fv(loc.u_matrix, false, m);
          gl.uniform1f(loc.u_light, l);
          gl.drawArrays(gl.POINTS, 0, level ? level.n : d.n);
        }
      },

      show: function (d, from, k) { data = d; prev = from || null; mix = from ? k : 1; map.triggerRepaint(); },

      refresh: function () { map.triggerRepaint(); },

      set: function (alpha, gain, radius) {
        params.alpha = alpha;
        params.gain = gain;
        params.radius = radius;
        map.triggerRepaint();
      },

      forget: function (uf) {
        buffers.forEach(function (buf, key) {
          if (key === uf || key.indexOf(uf + ":") === 0) {
            if (gl) gl.deleteBuffer(buf);
            buffers.delete(key);
          }
        });
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
  var sharedKnobs = null;   // slider values from a shared link, see showView

  function apply(fromZoom) {
    if (!map) return;
    var z = map.getZoom();
    if (fromZoom && sharedKnobs && Math.abs(z - sharedKnobs.zoom) > 0.01) sharedKnobs = null;
    if (fromZoom && sharedKnobs) {
      knobs.forEach(function (name) { setKnob(name, sharedKnobs[name]); });
    } else if (fromZoom) {
      var c = zoomCurve(z);
      setKnob("opacity", clamp(c.light, 0.05, 1));
      setKnob("brightness", clamp(brightCurve(z), 0.02, 2.5));
      setKnob("dotsize", c.size);
    }
    if (fromZoom) writeHashSoon();
    $("zoomval").textContent = z.toFixed(2);

    var data = current && cache.get(current);
    if (!data || !points) return;
    points.show(data, fadeFrom && cache.get(fadeFrom), fade);
    points.set(
      clamp(knobValue("opacity"), 0.05, 1),
      clamp(knobValue("brightness"), 0.02, 2.5),
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
  // With from, that place's points fade out meanwhile: landing on a state
  // over the Brasil sample, the state stays lit and the rest of the country
  // goes dark.
  var lightRun = 0;
  function lightUp(from) {
    var run = ++lightRun;
    fadeFrom = from && from !== current ? from : null;
    if (reduceMotion) { fade = 1; fadeFrom = null; schedule(false); return; }
    var start = performance.now();
    var DURATION = 1400;
    fade = 0;
    (function step(now) {
      if (run !== lightRun) return;
      var k = clamp((now - start) / DURATION, 0, 1);
      fade = k * k * (3 - 2 * k);
      if (k === 1) fadeFrom = null;
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
  var flight = 0;

  function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  // Ends a touch past 1 and comes back: the camera lands, then seats.
  function easeOutSeat(t) { var u = t - 1; return 1 + 2.2 * u * u * u + 1.2 * u * u; }

  // Flies to the place and resolves when the camera has arrived, or when the
  // flight was cut short (by the user, or by another fly()). With a view (from
  // a shared link) it lands straight on that camera instead of framing the place.
  function fly(uf, view) {
    var cam = cameraFor(uf);
    var target = Math.min(8, cam.zoom);
    var id = ++flight;
    var end = view || { center: cam.center, zoom: cam.zoom, pitch: tilted ? TILT : 0, bearing: 0 };
    // The arc between two places climbs well above both; minZoom would clip
    // it into a fast low pan, so open it all the way for the flight.
    map.setMinZoom(Math.min(map.getMinZoom(), 2));

    return new Promise(function (resolve) {
      // Never clamp below where the camera is: a flight cut short mid-arc
      // would otherwise snap.
      function settle() {
        map.setMinZoom(Math.min(target, map.getZoom()));
        schedule(true);
        resolve();
      }
      function arrived() {
        var at = map.getCenter(), to = maplibregl.LngLat.convert(end.center);
        return Math.abs(at.lng - to.lng) < 0.01 && Math.abs(at.lat - to.lat) < 0.01;
      }

      if (reduceMotion || view) {
        map.jumpTo(end);
        settle();
        return;
      }

      // Arrive a little high, then sink into the frame.
      // flyTo stops any running flight, which fires that flight's moveend
      // synchronously: listen only after it has started.
      map.flyTo({
        center: end.center,
        zoom: cam.zoom - 0.3,
        pitch: end.pitch,
        bearing: 0,
        speed: 1.2,
        curve: 1.2,
        maxDuration: 2800,
        easing: easeInOutCubic,
        essential: true,
      });
      map.once("moveend", function () {
        if (id !== flight || !arrived()) { if (id === flight) settle(); else resolve(); return; }
        map.easeTo(Object.assign({}, end, { duration: 700, easing: easeOutSeat, essential: true }));
        map.once("moveend", function () {
          if (id === flight) settle(); else resolve();
        });
      });
    });
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
    document.title = (uf === "BR" ? "brasilumen" : (NAMES[uf] + " · brasilumen"));
  }

  function markTiles(uf) {
    document.querySelectorAll(".tile[data-uf]").forEach(function (el) {
      el.setAttribute("aria-pressed", el.dataset.uf === uf ? "true" : "false");
    });
    $("picker-toggle-uf").textContent = uf;
  }

  function select(uf, view) {
    if (!meta[uf]) uf = "BR";
    if (uf === requested) {
      if (view) fly(uf, view);
      return;
    }
    requested = uf;
    markTiles(uf);
    setReadout(uf);
    // Fly over the whole-country sample, so the path between two states is
    // lit instead of black; the place's own points light up on arrival.
    if (current && current !== "BR" && current !== uf && cache.has("BR")) {
      var left = current;
      current = "BR";
      lightUp(left);
    }
    var landing = fly(uf, view);

    var label = "acendendo " + (uf === "BR" ? "o Brasil" : uf);
    var cached = cache.has(uf);
    showProgress(label, cached ? null : 0);
    // Downloaded before the camera lands: the bar holds full until it does.
    var loading = loadPoints(uf, function (f) { if (requested === uf) showProgress(label, f); })
      .then(function (data) { if (requested === uf && !cached) showProgress(label, 1); return data; });
    Promise.all([loading, landing])
      .then(function () {
        if (requested !== uf) return;
        var changed = current !== uf, from = current;
        current = uf;
        apply(true);
        hideProgress();
        if (changed) lightUp(from);
      })
      .catch(function (err) {
        if (requested !== uf) return;
        hideProgress(true);
        showError("Não foi possível carregar " + (NAMES[uf] || uf) + ": " + err.message + ". Recarregue a página para tentar de novo.");
      });
  }

  // The URL carries the place and the camera, so a link opens on the same
  // angle: #sp/12.40/-23.55012/-46.63331/15/50 is
  // place/zoom/lat/lng/bearing/pitch, optionally followed by the three
  // sliders, /opacidade/brilho/tamanho, so the link carries the look too.
  // A bare #sp still frames the whole place.
  //
  // The zoom in the URL is for a reference screen whose short side is
  // REF_SIDE px, so a link frames the same patch of ground on any screen: a
  // phone opens it a little further out, a big monitor a little closer in.
  var REF_SIDE = 1000;
  function screenShift() {
    var c = map.getContainer();
    return Math.log2(Math.min(c.clientWidth, c.clientHeight) / REF_SIDE);
  }
  function fromHash() {
    var parts = location.hash.replace("#", "").split("/");
    var uf = parts[0].toUpperCase();
    if (!meta[uf]) uf = "BR";
    var n = parts.slice(1).map(Number);
    if (n.length < 3 || n.slice(0, 3).some(isNaN)) return { uf: uf, view: null, knobs: null };
    var knobs = n.length >= 8 && !n.slice(5, 8).some(isNaN) ? {
      opacity: clamp(n[5], 0.05, 1),
      brightness: clamp(n[6], 0.02, 2.5),
      dotsize: clamp(n[7], 0.1, 2.5),
    } : null;
    return {
      uf: uf,
      knobs: knobs,
      view: {
        zoom: clamp(n[0] + screenShift(), 2, MAX_ZOOM),
        center: [clamp(n[2], -180, 180), clamp(n[1], -85, 85)],
        bearing: isNaN(n[3]) ? 0 : n[3],
        pitch: isNaN(n[4]) ? (tilted ? TILT : 0) : clamp(n[4], 0, 85),
      },
    };
  }

  function writeHash() {
    if (!requested) return;
    var c = map.getCenter();
    var hash = "#" + requested.toLowerCase() + "/" + (map.getZoom() - screenShift()).toFixed(2) + "/" +
      c.lat.toFixed(5) + "/" + c.lng.toFixed(5) + "/" +
      Math.round(map.getBearing()) + "/" + Math.round(map.getPitch()) + "/" +
      knobs.map(function (name) { return knobValue(name).toFixed(2); }).join("/");
    if (location.hash !== hash) history.replaceState(null, "", hash);
  }

  // Safari throttles replaceState, so the URL is written once the camera or a
  // slider has rested, after the sliders have taken their new values.
  var hashTimer = 0;
  function writeHashSoon() {
    clearTimeout(hashTimer);
    hashTimer = setTimeout(writeHash, 300);
  }

  function setTilted(on) {
    tilted = on;
    $("tilt").setAttribute("aria-pressed", on ? "true" : "false");
    $("tilt").textContent = on ? "inclinada" : "de cima";
  }

  // Takes fromHash()'s result and hands back the camera for select(). Shared
  // slider values hold while the camera stays at the shared zoom; the first
  // zoom away hands the sliders back to the zoom curve.
  function showView(h) {
    if (h.view) setTilted(h.view.pitch > 0);
    sharedKnobs = h.view && h.knobs ? Object.assign({ zoom: h.view.zoom }, h.knobs) : null;
    return h.view;
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
      $("peek-img").src = "thumbs/" + uf.toLowerCase() + ".webp";
      $("peek-name").textContent = NAMES[uf];
      $("peek-stats").textContent = fmt(meta[uf].n_estab_geolocalizados) + " estabelecimentos";
      peek.hidden = false;
    }
    $("picker").addEventListener("pointerover", function (e) {
      var t = e.target.closest(".tile[data-uf]");
      showPeek(t);
      prefetchSoon(t && t.dataset.uf);
    });
    $("picker").addEventListener("pointerleave", function () { peek.hidden = true; });
    $("picker").addEventListener("focusin", function (e) { showPeek(e.target.closest(".tile[data-uf]")); });
    $("picker").addEventListener("focusout", function () { peek.hidden = true; });
  }

  // Hovering a tile for a moment starts its download into the HTTP cache, so
  // the click usually finds the file already there. The delay keeps a mouse
  // sweeping across the grid from pulling every state.
  var prefetched = {};
  var prefetchTimer = 0;
  function prefetchSoon(uf) {
    clearTimeout(prefetchTimer);
    if (!uf || !meta[uf] || prefetched[uf] || cache.has(uf)) return;
    prefetchTimer = setTimeout(function () {
      prefetched[uf] = true;
      // Read the body through, or the browser may not keep it in the cache.
      fetch("data/" + uf.toLowerCase() + ".bin.gz", { priority: "low" })
        .then(function (r) { return r.arrayBuffer(); })
        .catch(function () { prefetched[uf] = false; });
    }, 250);
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
        writeHashSoon();
      });
    });

    $("tilt").addEventListener("click", function () {
      setTilted(!tilted);
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

    window.addEventListener("hashchange", function () {
      var h = fromHash();
      select(h.uf, showView(h));
    });
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
          map.on("moveend", writeHashSoon);
          var h = fromHash();
          select(h.uf, showView(h));
        });
      })
      .catch(function (err) {
        console.error(err);
        showError("Não foi possível carregar os dados (" + err.message + "). Recarregue a página para tentar de novo.");
      });
  }

  boot();
})();
