import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

const BASE_COLOR = 0x000000;
const BLOOM_STRENGTH = 0.6;
const BLOOM_RADIUS = 0.8;
const BLOOM_THRESHOLD = 0.1;

const MOBILE_MAX = 768;
const DPR_DESKTOP = 1.75;
const DPR_MOBILE = 1.25;
const COMPOSER_DPR_CAP = 1.25;

const VOL_X = 220;
const VOL_Y = 140;
const VOL_Z_NEAR = -90;
const VOL_Z_FAR = 30;

const MIN_STARS = 400;
const MAX_STARS = 2000;
const PIXELS_PER_STAR = 700;

const DRIFT = 1.6;
const REPEL_RADIUS = 34;
const REPEL_STRENGTH = 16;
const POINTER_LERP = 0.12;
const REPEL_LERP = 0.08;
const RESIZE_DEBOUNCE = 150;
const REVEAL_CLASS = 'site-starfield--ready';

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform vec3  uPointer;
  uniform float uRepelRadius;
  uniform float uRepelStrength;
  uniform float uDrift;
  uniform float uPixelRatio;

  attribute float aSize;
  attribute float aPhase;
  attribute float aTint;

  varying float vTint;
  varying float vTwinkle;

  void main() {
    vTint = aTint;

    vec3 p = position;
    p.x += sin(uTime * 0.18 + aPhase) * uDrift;
    p.y += cos(uTime * 0.13 + aPhase * 1.7) * uDrift * 0.7;
    p.z += sin(uTime * 0.09 + aPhase * 0.6) * uDrift * 0.5;

    vec3 delta = p - uPointer;
    float dist = length(delta.xy);
    float falloff = 1.0 - smoothstep(0.0, uRepelRadius, dist);
    p += normalize(delta + 1e-5) * falloff * uRepelStrength;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uPixelRatio * (140.0 / max(-mv.z, 0.001));

    vTwinkle = 0.62 + 0.38 * sin(uTime * 1.1 + aPhase * 3.1);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColorA;
  uniform vec3 uColorB;

  varying float vTint;
  varying float vTwinkle;

  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;

    float halo = smoothstep(0.5, 0.0, d);
    float core = pow(halo, 3.0);
    vec3 tint = mix(uColorA, uColorB, vTint);
    float alpha = (halo * 0.55 + core * 0.85) * vTwinkle;

    gl_FragColor = vec4(tint * (0.6 + core * 0.9), alpha);
  }
`;

function cssColor(name, fallbackHex) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const color = new THREE.Color();
  if (raw) {
    try {
      color.setStyle(raw);
    } catch (err) {
      color.setHex(fallbackHex);
    }
  } else {
    color.setHex(fallbackHex);
  }
  // r143 legacy colour management keeps values as-authored (sRGB), but the
  // composer's final pass encodes to sRGB on output -> convert once up front
  // so what reaches the screen is the exact brand colour, not a washed version
  return color.convertSRGBToLinear();
}

function initStarfield() {
  // The canvas is a single position:fixed child of <body> (see .site-starfield),
  // so it spans the whole viewport rather than one section.
  const canvas = document.querySelector('[data-starfield]');
  if (!canvas) return;

  // Size from the canvas' own painted box: CSS `inset:0` already makes it the
  // viewport, so this stays correct through mobile URL-bar collapse and
  // visualViewport changes. Fall back to the window if it is not laid out yet.
  function viewportSize() {
    const rect = canvas.getBoundingClientRect();
    const width = rect.width || window.innerWidth;
    const height = rect.height || window.innerHeight;
    return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
  }

  const initial = viewportSize();

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance'
    });
  } catch (err) {
    canvas.remove();
    return;
  }

  renderer.setClearColor(new THREE.Color(BASE_COLOR).convertSRGBToLinear(), 1);
  renderer.outputEncoding = THREE.sRGBEncoding;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, initial.width / initial.height, 0.1, 400);
  camera.position.set(0, 0, 70);

  const uniforms = {
    uTime: { value: 0 },
    uPointer: { value: new THREE.Vector3(0, 0, 0) },
    uRepelRadius: { value: REPEL_RADIUS },
    uRepelStrength: { value: 0 },
    uDrift: { value: DRIFT },
    uPixelRatio: { value: 1 },
    uColorA: { value: cssColor('--color-ivory', 0xf4f1ea) },
    uColorB: { value: cssColor('--color-gold', 0xc9a24b) }
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending
  });

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(initial.width, initial.height),
    BLOOM_STRENGTH,
    BLOOM_RADIUS,
    BLOOM_THRESHOLD
  );
  composer.addPass(bloomPass);

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const clock = new THREE.Clock();

  let points = null;
  let starCount = 0;
  let useComposer = false;
  let rafId = null;
  let tabVisible = !document.hidden;
  let resizeTimer = 0;

  const pointerTarget = new THREE.Vector3(0, 0, 0);
  const pointerCurrent = new THREE.Vector3(0, 0, 0);
  const ndc = new THREE.Vector2();
  const ray = new THREE.Vector3();
  let repelTarget = 0;
  let repelAmount = 0;

  function buildStars(count) {
    if (points) {
      scene.remove(points);
      points.geometry.dispose();
      points.material.dispose();
      points = null;
    }

    const positions = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const phases = new Float32Array(count);
    const tints = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * VOL_X;
      positions[i * 3 + 1] = (Math.random() - 0.5) * VOL_Y;
      positions[i * 3 + 2] = VOL_Z_NEAR + Math.random() * (VOL_Z_FAR - VOL_Z_NEAR);
      sizes[i] = 0.6 + Math.random() * 2.0;
      phases[i] = Math.random() * Math.PI * 2;
      tints[i] = Math.pow(Math.random(), 2);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
    geometry.setAttribute('aTint', new THREE.BufferAttribute(tints, 1));
    geometry.computeBoundingSphere();

    points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    scene.add(points);
    starCount = count;
  }

  function draw() {
    uniforms.uTime.value = clock.getElapsedTime();
    pointerCurrent.lerp(pointerTarget, POINTER_LERP);
    uniforms.uPointer.value.copy(pointerCurrent);
    repelAmount += (repelTarget - repelAmount) * REPEL_LERP;
    uniforms.uRepelStrength.value = repelAmount * REPEL_STRENGTH;

    if (useComposer) {
      composer.render();
    } else {
      renderer.render(scene, camera);
    }
  }

  function loop() {
    rafId = requestAnimationFrame(loop);
    draw();
  }

  function start() {
    if (rafId !== null || reduceMotion.matches || !tabVisible) return;
    clock.getDelta();
    rafId = requestAnimationFrame(loop);
  }

  function stop() {
    if (rafId === null) return;
    cancelAnimationFrame(rafId);
    rafId = null;
  }

  function resize() {
    const { width, height } = viewportSize();
    const mobile = window.innerWidth <= MOBILE_MAX;
    const dpr = Math.min(window.devicePixelRatio || 1, mobile ? DPR_MOBILE : DPR_DESKTOP);

    useComposer = !mobile && !reduceMotion.matches;

    camera.aspect = width / height;
    camera.updateProjectionMatrix();

    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);

    composer.setPixelRatio(Math.min(dpr, COMPOSER_DPR_CAP));
    composer.setSize(width, height);

    uniforms.uPixelRatio.value = dpr;
    uniforms.uDrift.value = mobile ? DRIFT * 0.7 : DRIFT;

    const target = Math.round(
      Math.min(MAX_STARS, Math.max(MIN_STARS, (width * height) / PIXELS_PER_STAR))
    );
    if (target !== starCount) buildStars(target);

    if (rafId === null) draw();
  }

  // Repel responds to the cursor across the whole viewport, not just one
  // section. The canvas fills 0,0 -> vw,vh so the NDC mapping is unchanged.
  window.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'touch') return;

    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    ray.set(ndc.x, ndc.y, 0.5).unproject(camera);
    ray.sub(camera.position);
    if (Math.abs(ray.z) < 1e-6) return;
    ray.normalize();

    const distance = -camera.position.z / ray.z;
    pointerTarget.copy(camera.position).addScaledVector(ray, distance);
    repelTarget = 1;
  });

  document.addEventListener('pointerleave', () => {
    repelTarget = 0;
  });

  document.addEventListener('visibilitychange', () => {
    tabVisible = !document.hidden;
    if (tabVisible) start();
    else stop();
  });

  const onMotionChange = () => {
    resize();
    if (reduceMotion.matches) {
      stop();
      draw();
    } else {
      start();
    }
  };
  if (reduceMotion.addEventListener) {
    reduceMotion.addEventListener('change', onMotionChange);
  } else if (reduceMotion.addListener) {
    reduceMotion.addListener(onMotionChange);
  }

  const scheduleResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, RESIZE_DEBOUNCE);
  };

  // Observe the canvas itself: a fixed inset:0 element's box tracks the
  // viewport, so this fires on resize, orientation change and mobile URL-bar
  // collapse without any extra listeners.
  const observer = new ResizeObserver(scheduleResize);
  observer.observe(canvas);

  window.addEventListener('orientationchange', scheduleResize);

  window.addEventListener('pagehide', () => {
    stop();
    clearTimeout(resizeTimer);
    observer.disconnect();

    try {
      if (points) {
        scene.remove(points);
        points.geometry.dispose();
        points.material.dispose();
        points = null;
      }
      material.dispose();

      // r0.143.0's EffectComposer has no dispose(); each Pass does (Pass.prototype.dispose)
      if (typeof composer.dispose === 'function') {
        composer.dispose();
      } else {
        composer.passes.forEach((pass) => {
          if (pass && typeof pass.dispose === 'function') pass.dispose();
        });
        if (composer.renderTarget1) composer.renderTarget1.dispose();
        if (composer.renderTarget2) composer.renderTarget2.dispose();
      }

      renderer.dispose();
      renderer.forceContextLoss();
    } catch (err) {
      /* teardown must never surface as an uncaught error */
    }
  }, { once: true });

  function reveal() {
    // first frame is already painted, so cross-fade the starfield in over it
    requestAnimationFrame(() => canvas.classList.add(REVEAL_CLASS));
  }

  resize();
  draw();
  reveal();
  start();
}

let initialized = false;

function boot() {
  if (initialized) return;
  initialized = true;
  initStarfield();
}

boot();
