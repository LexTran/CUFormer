"use strict";

/* ---------------- disabled resource links ---------------- */
document.querySelectorAll('a[aria-disabled="true"], a[href=""]').forEach((link) => {
  const blockNavigation = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };

  link.addEventListener("click", blockNavigation);
  link.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      blockNavigation(event);
    }
  });
});

const $ = (selector) => document.querySelector(selector);
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------------- demo 1: CT on live ultrasound ----------------
   sweep.mp4 is ONE clip with three panels side by side: raw (480x380) | overlay (480x380) | locator (240x380).
   Each frame is cut from the same decoded video into three canvases, so the panels can never drift apart. */
(function sweepDemo() {
  const video = $("#sweepVideo");
  if (!video) return;
  const compare = $("#sweepCompare");
  const canvases = [$("#sweepRaw"), $("#sweepOverlay"), $("#sweepLocator")];
  const split = $("#sweepSplit");
  const seek = $("#sweepSeek");
  const play = $("#sweepPlay");
  const PANEL_W = [480, 480, 240];      // raw | overlay | locator (portrait)
  const PANEL_X = [0, 480, 960];
  const PANEL_H = 380;
  let seeking = false;

  canvases.forEach((canvas, k) => {
    canvas.width = PANEL_W[k];
    canvas.height = PANEL_H;
  });

  const draw = () => {
    if (video.readyState < 2) return;
    canvases.forEach((canvas, k) => {
      canvas.getContext("2d").drawImage(video, PANEL_X[k], 0, PANEL_W[k], PANEL_H, 0, 0, PANEL_W[k], PANEL_H);
    });
    if (!seeking && video.duration) seek.value = Math.round((video.currentTime / video.duration) * 1000);
  };

  const loop = () => {
    draw();
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(loop);
    else requestAnimationFrame(loop);
  };

  const setSplit = (percent) => {
    const value = Math.max(0, Math.min(100, percent));
    compare.style.setProperty("--split", value + "%");
    split.value = value;
  };

  const setPlaying = (playing) => {
    if (playing) video.play().catch(() => {});
    else video.pause();
    play.setAttribute("aria-label", playing ? "Pause" : "Play");
    play.innerHTML = `<span class="icon"><i class="fas fa-${playing ? "pause" : "play"}" aria-hidden="true"></i></span>`;
  };

  video.addEventListener("loadeddata", () => {
    draw();
    loop();
  });
  video.addEventListener("seeked", draw);

  split.addEventListener("input", () => setSplit(Number(split.value)));
  let dragging = false;
  const fromPointer = (event) => {
    const box = compare.getBoundingClientRect();
    setSplit(((event.clientX - box.left) / box.width) * 100);
  };
  compare.addEventListener("pointerdown", (event) => {
    dragging = true;
    compare.setPointerCapture(event.pointerId);
    fromPointer(event);
  });
  compare.addEventListener("pointermove", (event) => {
    if (dragging) fromPointer(event);
  });
  compare.addEventListener("pointerup", () => {
    dragging = false;
  });

  seek.addEventListener("input", () => {
    seeking = true;
    if (video.duration) video.currentTime = (Number(seek.value) / 1000) * video.duration;
  });
  seek.addEventListener("change", () => {
    seeking = false;
  });
  play.addEventListener("click", () => setPlaying(video.paused));

  // Play while the demo is on screen.
  if (!reduceMotion && "IntersectionObserver" in window) {
    new IntersectionObserver((entries) => {
      entries.forEach((entry) => setPlaying(entry.isIntersecting));
    }, { threshold: 0.35 }).observe(compare);
  } else {
    setPlaying(false);
  }
})();

/* ---------------- demo 2: registration explorer ----------------
   Data (static/js/explorer_data.js): CT points in the pose CUFormer receives, US/depth points, predicted CT visibility,
   and the estimate x' = R x + t that places the CT onto the intraoperative points (mm, origin at the US centroid).
   The window keeps the CT fixed and moves the US by the inverse, u' = R^T (u - t): the same relative alignment.
   The slider interpolates rotation (slerp) and translation (lerp) between identity and that inverse for display. */
(function explorerDemo() {
  const canvas = $("#explorerCanvas");
  if (!canvas) return;
  const cases = window.CUF_EXPLORER;
  if (!window.THREE || !cases) {
    $("#explorerFallback").hidden = false;
    return;
  }
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  } catch (error) {
    $("#explorerFallback").hidden = false;
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0xffffff, 1);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xffffff, 100, 1000);
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 5000);
  const controls = new THREE.OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  const CT_COLOR = new THREE.Color("#3B6FB5");
  const US_COLOR = new THREE.Color("#E8703A");
  // inferno, 9 stops (dark: unseen, bright: visible)
  const INFERNO = ["#000004", "#1b0c41", "#4a0c6b", "#781c6d", "#a52c60", "#cf4446", "#ed6925", "#fb9b06", "#fcffa4"].map((c) => new THREE.Color(c));
  const inferno = (v) => {
    const x = Math.max(0, Math.min(1, v)) * (INFERNO.length - 1);
    const i = Math.min(INFERNO.length - 2, Math.floor(x));
    return INFERNO[i].clone().lerp(INFERNO[i + 1], x - i);
  };

  const sprite = (() => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d");
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.72, "rgba(255,255,255,1)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();

  const decode = (b64, Type) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new Type(bytes.buffer);
  };

  const prepared = cases.map((c) => {
    const ct = decode(c.ct, Float32Array);
    const us = decode(c.us, Float32Array);
    const vis = decode(c.vis, Uint8Array);
    const m = c.R;
    const rot = new THREE.Matrix4().set(m[0][0], m[0][1], m[0][2], 0, m[1][0], m[1][1], m[1][2], 0, m[2][0], m[2][1], m[2][2], 0, 0, 0, 0, 1);
    const q1 = new THREE.Quaternion().setFromRotationMatrix(rot);
    const t1 = new THREE.Vector3(c.t[0], c.t[1], c.t[2]);
    // CT fixed; US moved by the inverse estimate u' = R^T (u - t)
    const qInv = q1.clone().invert();
    const tInv = t1.clone().applyQuaternion(qInv).negate();
    // framing: the fixed CT together with the aligned US
    const box = new THREE.Box3();
    const p = new THREE.Vector3();
    for (let i = 0; i < ct.length; i += 3) box.expandByPoint(p.set(ct[i], ct[i + 1], ct[i + 2]));
    for (let i = 0; i < us.length; i += 3) box.expandByPoint(p.set(us[i], us[i + 1], us[i + 2]).applyQuaternion(qInv).add(tInv));
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    return { meta: c, ct, us, vis, qInv, tInv, sphere };
  });

  let current = null;
  let ctPoints = null;
  let usPoints = null;
  const alignT = $("#alignT");
  const visToggle = $("#visToggle");
  const usToggle = $("#usToggle");
  const legend = $("#explorerLegend");

  const pointsFrom = (positions, size) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(positions.length), 3));
    const material = new THREE.PointsMaterial({ size, vertexColors: true, map: sprite, alphaTest: 0.5, sizeAttenuation: true });
    return new THREE.Points(geometry, material);
  };

  const paintCT = () => {
    const colors = ctPoints.geometry.attributes.color;
    for (let i = 0; i < colors.count; i += 1) {
      const col = visToggle.checked ? inferno(current.vis[i] / 255) : CT_COLOR;
      colors.setXYZ(i, col.r, col.g, col.b);
    }
    colors.needsUpdate = true;
  };

  const applyT = () => {
    const t = Number(alignT.value) / 1000;
    usPoints.quaternion.copy(new THREE.Quaternion().slerp(current.qInv, t));   // CT stays fixed
    usPoints.position.copy(current.tInv).multiplyScalar(t);
  };

  const updateLegend = () => {
    const m = current.meta;
    const pts = m.us_modality === "depth" ? "depth points" : "ultrasound";
    legend.innerHTML = `<span class="legend-case">${m.label} · ${m.dataset}</span>` +
      (visToggle.checked
        ? `<span class="legend-item"><span class="legend-bar"></span>CT visibility: unseen → visible</span>`
        : `<span class="legend-item"><span class="dot" style="background:#3B6FB5"></span>CT</span>`) +
      `<span class="legend-item"><span class="dot" style="background:#E8703A"></span>${pts}</span>` +
      `<span class="legend-metric">CUFormer: RRE ${m.rre_deg.toFixed(2)}°, RTE ${m.rte_mm.toFixed(2)} mm, RMSE ${m.rmse_mm.toFixed(2)} mm</span>`;
    usToggle.parentElement.lastChild.textContent = " " + (m.us_modality === "depth" ? "Depth points" : "Ultrasound");
  };

  const select = (index) => {
    current = prepared[index];
    if (ctPoints) scene.remove(ctPoints);
    if (usPoints) scene.remove(usPoints);
    const size = current.sphere.radius * 0.018;
    ctPoints = pointsFrom(current.ct, size);
    usPoints = pointsFrom(current.us, size * 1.1);
    const uc = usPoints.geometry.attributes.color;
    for (let i = 0; i < uc.count; i += 1) uc.setXYZ(i, US_COLOR.r, US_COLOR.g, US_COLOR.b);
    usPoints.visible = usToggle.checked;
    scene.add(ctPoints, usPoints);
    paintCT();
    applyT();
    const r = current.sphere.radius;
    controls.target.copy(current.sphere.center);
    const v = current.meta.view;                  // broad side of the registered CT, long axis horizontal
    const dir = new THREE.Vector3(v.dir[0], v.dir[1], v.dir[2]).normalize();
    const up = new THREE.Vector3(v.up[0], v.up[1], v.up[2]).normalize();
    dir.add(up.clone().multiplyScalar(0.35)).normalize();   // slight elevation for depth
    camera.up.copy(up);
    camera.position.copy(current.sphere.center).add(dir.multiplyScalar(r * 2.7));
    controls.update();
    document.querySelectorAll("#explorerTabs button").forEach((b, k) => {
      b.classList.toggle("is-active", k === index);
      b.setAttribute("aria-selected", k === index ? "true" : "false");
    });
    updateLegend();
  };

  const tabs = $("#explorerTabs");
  prepared.forEach((c, k) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "button is-small is-rounded";
    b.setAttribute("role", "tab");
    b.textContent = c.meta.label;
    b.addEventListener("click", () => select(k));
    tabs.appendChild(b);
  });

  alignT.addEventListener("input", applyT);
  visToggle.addEventListener("change", () => {
    paintCT();
    updateLegend();
  });
  usToggle.addEventListener("change", () => {
    usPoints.visible = usToggle.checked;
  });

  let anim = null;
  $("#alignPlay").addEventListener("click", () => {
    const from = Number(alignT.value) / 1000;
    const to = from > 0.5 ? 0 : 1;
    const start = performance.now();
    const duration = reduceMotion ? 1 : 1600;
    cancelAnimationFrame(anim);
    const step = (now) => {
      const u = Math.min(1, (now - start) / duration);
      const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
      alignT.value = Math.round((from + (to - from) * e) * 1000);
      applyT();
      if (u < 1) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  });

  const resize = () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * renderer.getPixelRatio()) || canvas.height !== Math.round(h * renderer.getPixelRatio())) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  };

  const render = () => {
    resize();
    controls.update();
    if (current) {
      const d = camera.position.distanceTo(controls.target);
      scene.fog.near = d - current.sphere.radius * 0.6;
      scene.fog.far = d + current.sphere.radius * 2.2;
    }
    renderer.render(scene, camera);
    requestAnimationFrame(render);
  };

  select(0);
  render();
})();
