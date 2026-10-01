(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Look. Dot color and radius come from the kepler.gl config the original RJ
  // map was made with (color [139,87,79], radius 3). kepler scales its radius
  // before handing it to deck.gl; 1/3 matches its rendered dot size, measured
  // against the reference screenshots.
  var DOT_COLOR = [139, 87, 79];
  var BASE_RADIUS = 3 / 3;
  var TILT = 50;
  var TILT_ZOOM_OUT = 0.45;
  var MAX_ZOOM = 15;

  // Zoom-driven dot geometry. With radiusUnits:"pixels" a dot keeps its screen
  // size while points spread 2x per zoom level, so one fixed tuning only looks
  // right at one zoom. t=0 is the fitted view of the current place (dense glow,
  // the kepler-matched defaults); t=1 is max zoom (each dot a visible lamp).
  // radius is linear in t; alpha is geometric, because additive light is read
  // as ratios. brilho (the float gain) stays fixed as a stable reference.
  var ZOOM_AUTO = { radius: [1.0, 1.25], alpha: [0.8, 1.0] };
  var BRILHO_FIXED = 1.25;

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
  function lerpLinear(r, t) { return r[0] + (r[1] - r[0]) * t; }
  function lerpGeom(r, t) { return r[0] * Math.pow(r[1] / r[0], t); }

  // ---------------------------------------------------------------------------
  // State

  var meta = null;
  var map = null;
  var overlay = null;
  var current = null;      // uf whose points are on screen
  var requested = null;    // uf the user last asked for
  var zFit = 4;            // fitted zoom of the current place, t=0 of the curve
  var tilted = true;
  var manual = { opacity: false, brightness: false, dotsize: false };
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
    if (d.ok) p.resolve({ n: d.n, positions: d.positions });
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
      // binaryData must be a stable object: a fresh wrapper makes deck.gl
      // re-upload millions of positions on every rebuild (and we rebuild per
      // zoom frame).
      var data = {
        uf: uf,
        n: pts.n,
        binary: { length: pts.n, attributes: { getPosition: { value: pts.positions, size: 2 } } },
      };
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

  // deck.gl multiplies vertex alpha (opacidade, 8-bit) by the layer `opacity`
  // prop (brilho, a float that can exceed 1) before additive blending sums the
  // dots. brilho therefore sets how many stacked dots it takes to reach white.
  function buildLayer(data, alpha, gain, radius) {
    return new deck.ScatterplotLayer({
      id: "pts-" + data.uf,
      data: data.binary,
      getFillColor: DOT_COLOR.concat([Math.round(255 * alpha)]),
      getRadius: BASE_RADIUS * radius,
      radiusUnits: "pixels",
      opacity: gain,
      pickable: false,
      billboard: true, // camera-facing dots, like kepler; flat discs smear under tilt
      parameters: {
        blend: true,
        blendFunc: [WebGLRenderingContext.SRC_ALPHA, WebGLRenderingContext.ONE],
        blendEquation: WebGLRenderingContext.FUNC_ADD,
        depthTest: false,
      },
    });
  }

  var knobs = ["opacity", "brightness", "dotsize"];

  function knobValue(name) { return parseFloat($(name).value); }

  function setKnob(name, v) {
    $(name).value = v;
    $(name + "-out").textContent = (+v).toFixed(2);
  }

  function apply() {
    if (!map) return;
    var z = map.getZoom();
    var t = clamp((z - zFit) / Math.max(MAX_ZOOM - zFit, 1e-9), 0, 1);
    if (!manual.opacity) setKnob("opacity", lerpGeom(ZOOM_AUTO.alpha, t));
    if (!manual.dotsize) setKnob("dotsize", lerpLinear(ZOOM_AUTO.radius, t));
    if (!manual.brightness) setKnob("brightness", BRILHO_FIXED);
    $("zoomval").textContent = z.toFixed(2);

    var data = current && cache.get(current);
    if (!data || !overlay) return;
    overlay.setProps({
      layers: [buildLayer(
        data,
        clamp(knobValue("opacity"), 0.05, 1),
        clamp(knobValue("brightness"), 0.02, 2.5) * fade,
        Math.max(knobValue("dotsize"), 0.1)
      )],
    });
  }

  var frame = 0;
  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(function () { frame = 0; apply(); });
  }

  // The lights come on: ramp the gain from 0 when a new point set lands.
  function lightUp() {
    if (reduceMotion) { fade = 1; schedule(); return; }
    var start = performance.now();
    var DURATION = 1400;
    fade = 0;
    (function step(now) {
      var k = clamp((now - start) / DURATION, 0, 1);
      fade = k * k * (3 - 2 * k);
      apply();
      if (k < 1) requestAnimationFrame(step);
    })(start);
  }

  // ---------------------------------------------------------------------------
  // Camera

  function padding() {
    var small = window.innerWidth <= 640;
    if (small) return { top: 150, bottom: 70, left: 16, right: 16 };
    // Keep the place clear of the picker: beside it on landscape screens,
    // above it on portrait ones.
    var picker = $("picker").getBoundingClientRect();
    if (window.innerWidth > window.innerHeight) {
      return { top: 60, bottom: 40, left: Math.min(picker.width + 50, window.innerWidth * 0.4), right: 40 };
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

  function fly(uf) {
    var cam = cameraFor(uf);
    zFit = cam.zoom;
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
        if (cached) schedule(); else lightUp();
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
      var panel = $("light-panel");
      panel.hidden = !panel.hidden;
      this.setAttribute("aria-expanded", panel.hidden ? "false" : "true");
    });

    knobs.forEach(function (name) {
      $(name).addEventListener("input", function () {
        manual[name] = true;
        $(name).closest(".knob").classList.add("manual");
        $(name + "-out").textContent = (+this.value).toFixed(2);
        $("auto").disabled = false;
        schedule();
      });
    });

    $("auto").addEventListener("click", function () {
      knobs.forEach(function (name) {
        manual[name] = false;
        $(name).closest(".knob").classList.remove("manual");
      });
      this.disabled = true;
      schedule();
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
        $("light-panel").hidden = true;
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
          antialias: true,
          attributionControl: false,
        });

        map.on("load", function () {
          overlay = new deck.MapboxOverlay({ interleaved: false, layers: [] });
          map.addControl(overlay);
          map.on("zoom", schedule);
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
