import * as THREE from 'three';
import { CASES } from './cases.js';

const $ = id => document.getElementById(id);
const stage = $('stage'), cursor = $('cursor'), focus = $('focus'), focusLabel = $('focusLabel'), vMedia = $('viewerMedia');
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const pad = n => String(n).padStart(2, '0');
const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, k) => a + (b - a) * k;

// раскладка первого экрана: a - заголовок слева, облако справа; c - заголовок строкой внизу; e - кольцо вокруг заголовка
const LAYOUT = document.documentElement.dataset.layout || 'a';
const RING = LAYOUT === 'e';
const R_OPEN = 10;            // радиус раскрытого облака
const R_COMPACT = RING ? 8.6 : 5;   // радиус сжатого: шар собирается в плотный ком, кольцо только чуть сужается
// карточка в раскрытом и сжатом виде: в шаре крупно, как в рефе; в кольце мельче, как у cipher.tv
const SIZE_OPEN = RING ? 2.4 : 4.6, SIZE_COMPACT = RING ? 1.7 : 3.2;
let TILT = RING ? .42 : .18;     // наклон по X в покое: кольцо видно эллипсом; на телефоне круче, места по высоте много
const FOV = 24;               // узкий угол камеры = слабая перспектива, как у It's Nice That
const AUTO_SPIN = .07;        // рад/с, собственное вращение
const DRAG = .0052;           // рад на пиксель перетаскивания
const WAIT_MAX = 2500;        // дольше этого не ждём картинки перед вылетом облака
const ORIGIN = new THREE.Vector3(0, 0, -R_OPEN * 1.3);   // точка в глубине, откуда вылетают карточки
const LENS = 120;             // радиус линзы-курсора, CSS px
const LENS_SOFT = 46;         // мягкий край проявки, CSS px
const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;

/* ---------- Сцена ---------- */
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
// 1.5 вместо 2 на ретине: на 44% меньше пикселей, на глаз разницы почти нет
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0xffffff, 1);
stage.append(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(FOV, 1, .1, 300);
const TEX_MAX = matchMedia('(max-width: 700px)').matches ? 512 : 640;          // максимальная сторона текстуры в облаке: карточка на экране меньше 300px
const textures = new Map();
const geo = new THREE.PlaneGeometry(1, 1);

/* ---------- Проявка: облако монохромное, цвет только в линзе курсора и на захваченной карточке ---------- */
const LENS_U = {
  uMouse: { value: new THREE.Vector2(-1e4, -1e4) },   // в пикселях буфера, origin снизу слева
  uRadius: { value: 0 },
  uSoft: { value: LENS_SOFT },
  uAll: { value: 1 },                                  // 1 = всё в цвете (вход, тач-экраны)
};

function makeMaterial() {
  const mat = new THREE.MeshBasicMaterial({ color: 0xf0f0f0 });
  mat.userData.uHover = { value: 0 };
  mat.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, LENS_U, { uHover: mat.userData.uHover });
    sh.fragmentShader = 'uniform vec2 uMouse; uniform float uRadius, uSoft, uAll, uHover;\n' + sh.fragmentShader.replace(
      '#include <map_fragment>',
      `#include <map_fragment>
      float lensK = 1.0 - smoothstep(uRadius - uSoft, uRadius, distance(gl_FragCoord.xy, uMouse));
      float colorK = max(max(uAll, uHover), lensK * step(1.0, uRadius));
      float luma = dot(diffuseColor.rgb, vec3(.299, .587, .114));
      diffuseColor.rgb = mix(vec3(luma) * 1.04, diffuseColor.rgb, colorK);`
    );
  };
  return mat;
}

function texture(c) {
  const src = c.thumb || c.img;   // облаку хватает миниатюры, полноразмерные кадры грузит только открытый кейс
  if (!textures.has(src)) {
    // облаку не нужен оригинал: уменьшаем до TEX_MAX и сразу грузим в видеокарту,
    // чтобы не было подвисаний на первом кадре с этой картинкой
    const t = new THREE.Texture();
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = src;
    // decode() распаковывает картинку вне основного потока, анимация не ждёт
    t.userData.ready = img.decode().then(() => {
      const s = Math.min(1, TEX_MAX / Math.max(img.naturalWidth, img.naturalHeight));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.naturalWidth * s);
      cv.height = Math.round(img.naturalHeight * s);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      t.image = cv;
      t.needsUpdate = true;
      renderer.initTexture(t);
      t.userData.loaded = true;
    }).catch(() => {});
    textures.set(src, t);
  }
  return textures.get(src);
}

let W, H, mobile, D;
let cards = [], meshes = [];   // meshes - готовый список для рейкаста, без пересборки каждый кадр
const cloudAt = { x: 0, y: 0, ppu: 1 };   // центр облака на экране и пикселей на единицу сцены
let openK = 0;                // 0 - облако сжато, 1 - раскрыто

/* ---------- Карточки ---------- */
function build() {
  cards.forEach(k => scene.remove(k.mesh));
  // как у It's Nice That: немного карточек, но крупных, плотно внахлёст
  const M = mobile ? 12 : 16;
  // направления по сфере (спираль Фибоначчи) с разбросом по радиусу: объём, а не оболочка
  cards = Array.from({ length: M }, (_, i) => {
    let base;
    if (RING) {
      // кольцо: карточки по окружности в плоскости XZ, лёгкий разброс, чтобы не было механически ровно
      const a = i / M * Math.PI * 2;
      base = new THREE.Vector3(Math.cos(a), (Math.random() - .5) * .08, Math.sin(a)).multiplyScalar(.96 + Math.random() * .08);
    } else {
      const y = 1 - (i + .5) / M * 2, r = Math.sqrt(1 - y * y), th = i * 2.39996;
      base = new THREE.Vector3(Math.cos(th) * r, y, Math.sin(th) * r).multiplyScalar(.85 + Math.random() * .23);
    }
    const mesh = new THREE.Mesh(geo, makeMaterial());
    scene.add(mesh);
    return { i, mesh, base, sz: RING ? .9 + Math.random() * .2 : .85 + Math.random() * .35, c: null, s: 0, hover: 0, delay: 0 };
  });
  meshes = cards.map(k => k.mesh);
  assign();
}

function assign() {
  cards.forEach((k, i) => {
    k.c = CASES[i % CASES.length];
    k.mesh.material.map = texture(k.c);
    k.mesh.material.color.set(0xffffff);
    k.mesh.material.needsUpdate = true;
    k.mesh.userData.card = k;
  });
}

function fit() {
  // окно ещё не получило размер (страницу открыли во встроенном окне нулевого размера): ждём следующего кадра
  if (!innerWidth || !innerHeight) return;
  W = innerWidth; H = innerHeight;
  const wasMobile = mobile;
  mobile = W < 700;
  if (RING) TILT = mobile ? .95 : .42;
  fitHeadline();
  renderer.setSize(W, H);
  camera.aspect = W / H;
  // на десктопе облако в свободном месте: справа от текста или в правой половине над заголовком, где просторнее
  const areaR = W - Math.max(24, W * .029);
  let openPx;
  if (RING) {
    // кольцо вокруг заголовка: центр - центр слов, радиус всегда шире слов, даже в сжатом виде
    const hb = document.querySelector('.headline').getBoundingClientRect();
    const descTop = document.querySelector('.desc').getBoundingClientRect().top;
    const top = document.querySelector('.top').getBoundingClientRect().bottom;
    const gut = Math.max(16, W * .029);
    cloudAt.x = W / 2; cloudAt.y = hb.top + hb.height / 2;
    const minR = hb.width / 2 * 1.32 / (R_COMPACT / R_OPEN);        // сжатое кольцо не заходит внутрь слов
    // по высоте кольцо наклонено: его полувысота около 0.62 радиуса, по ширине - 1.18 с учётом карточек
    const vk = Math.sin(TILT) + .2;   // полувысота кольца в радиусах с учётом карточек
    const fitR = Math.min(W * .36, (W / 2 - gut) / 1.18, (cloudAt.y - top) / vk, (descTop - 12 - cloudAt.y) / vk);
    openPx = Math.max(minR, fitR);
  } else if (mobile) { cloudAt.x = W / 2; cloudAt.y = H * .42; openPx = W * .44; }
  else if (LAYOUT === 'c') {
    // заголовок строкой на всю ширину внизу, облако в свободной полосе над ним, правее центра
    const tb = textBox(), top = document.querySelector('.logo').getBoundingClientRect().bottom + 24;
    openPx = Math.min((tb.top - 24 - top) / 2 * 1.08, W * .2);
    cloudAt.x = W * .64; cloudAt.y = (top + tb.top - 24) / 2;
  } else {
    const tb = textBox(), top = document.querySelector('.logo').getBoundingClientRect().bottom + 24;
    // A: колонка справа от текста на всю высоту
    const aL = tb.right + 40, aR = Math.min(H * .37, (areaR - aL) / 2 * .8);
    // B: прижато к правому краю над заголовком; раскрытое может краем зайти под строку, сжатое нет
    const bR = Math.min(H * .35, (areaR - W * .5) / 2);
    if (aR >= bR) { cloudAt.x = (aL + areaR) / 2; cloudAt.y = H / 2; openPx = aR; }
    else { cloudAt.x = areaR - bR; cloudAt.y = Math.min(top + bR * .9, H / 2); openPx = bR; }
  }
  // раскрытое облако целиком в кадре: от центра до края экрана и шапки должно хватать места
  // на радиус плюс половину крупной ближней карточки (K - запас на это и на перспективу)
  if (!mobile && !RING) {
    const K = 1.42, gut = Math.max(24, W * .029);
    const top = document.querySelector('.top').getBoundingClientRect().bottom - gut * .5;
    openPx = Math.min(openPx, (W - gut - cloudAt.x) / K, (cloudAt.x - gut) / K, (cloudAt.y - top) / K, (H - gut - cloudAt.y) / K);
  }
  if (LAYOUT === 'c' && !mobile) {
    // подсказка в одну линию с описанием, справа, над заголовком
    const d = document.querySelector('.desc').getBoundingClientRect();
    document.querySelector('.hint').style.bottom = (H - d.bottom) + 'px';
  }
  const t = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
  D = R_OPEN * (H / 2) / (openPx * t);
  cloudAt.ppu = H / (2 * t * D);
  camera.position.set(0, 0, D);
  camera.lookAt(0, 0, 0);
  // сдвиг кадра вместо поворота камеры: облако смотрит прямо на зрителя, но стоит не в центре
  camera.setViewOffset(W, H, -(cloudAt.x - W / 2), -(cloudAt.y - H / 2), W, H);
  camera.updateProjectionMatrix();
  scene.fog = new THREE.Fog(themeBg(), D - R_OPEN * .5, D + R_OPEN * 6);
  if (wasMobile !== mobile) {
    rot.x = rot.tx = TILT;   // наклон кольца сразу нужный, без долгого доворота
    phase = 'wait';
    build();
    // вылет один раз и только когда картинки готовы: загрузка не ложится на анимацию
    const all = Promise.all(cards.map(k => k.mesh.material.map.userData.ready));
    Promise.race([all, new Promise(r => setTimeout(r, WAIT_MAX))]).then(() => start('intro'));
  }
}

// вариант c: заголовок одной строкой ровно на ширину экрана минус поля
function fitHeadline() {
  const h = document.querySelector('.headline');
  h.style.fontSize = '';
  if (LAYOUT !== 'c' || mobile) return;
  const side = parseFloat(getComputedStyle(document.querySelector('.intro')).left) || 56;
  h.style.fontSize = '100px';
  const rg = document.createRange(); rg.selectNodeContents(h);
  h.style.fontSize = (100 * (W - 2 * side) / rg.getBoundingClientRect().width).toFixed(2) + 'px';
}

// рамка текста слева (заголовок и описание), по самим строкам, а не по ширине блока
function textBox() {
  let right = 0, top = 1e9;
  for (const el of document.querySelectorAll('.headline, .desc')) {
    const rg = document.createRange(); rg.selectNodeContents(el);
    const b = rg.getBoundingClientRect(); right = Math.max(right, b.right); top = Math.min(top, b.top);
  }
  return { right, top };
}

/* ---------- Фазы: ожидание картинок, вылет из глубины, вращение ---------- */
let phase = 'wait', phaseAt = 0;
function start(p) {
  phase = p; phaseAt = performance.now();
  cards.forEach((k, i) => { k.delay = i * 28; });
}

function spreadOf(k, now) {
  if (phase === 'wait') return 0;
  if (reduced || phase === 'live') return 1;
  return ease(clamp((now - phaseAt - k.delay) / 1300, 0, 1));
}

/* ---------- Вращение мышью с инерцией ---------- */
// tx/ty - целевой угол от мыши; облако догоняет его в кадре, а не прыгает в каждом событии
const rot = { x: TILT, y: 0, tx: TILT, ty: 0, vx: 0, vy: 0 };
const drag = { on: false, moved: 0, x: 0, y: 0, t: 0, t0: 0, card: null };
const CLICK_MOVE = 5, CLICK_MS = 320;   // клик = короткое нажатие почти без сдвига, всё остальное вращение
const MAX_FLING = 3.5;        // рад/с, потолок инерции после отпускания
let hovered = null, opened = null, openAt = 0;
const mouse = new THREE.Vector2(-9, -9), ray = new THREE.Raycaster();

stage.addEventListener('pointerdown', e => {
  if (opened) return;
  drag.on = true; drag.moved = 0; drag.x = e.clientX; drag.y = e.clientY; drag.t = drag.t0 = e.timeStamp;
  drag.card = pick(e.clientX, e.clientY);
  rot.tx = rot.x; rot.ty = rot.y; rot.vx = rot.vy = 0;
  stage.setPointerCapture(e.pointerId);
  cursor.classList.add('is-drag');
});

function pick(x, y) {
  if (phase !== 'live') return null;
  ray.setFromCamera(new THREE.Vector2(x / W * 2 - 1, -(y / H) * 2 + 1), camera);
  const h = ray.intersectObjects(meshes, false);
  return h.length ? h[0].object.userData.card : null;
}

let hasMouse = false, activeAt = -1e9;
const ptr = { x: -1e4, y: -1e4 };
addEventListener('pointermove', e => {
  ptr.x = e.clientX; ptr.y = e.clientY;
  cursor.style.translate = `${e.clientX}px ${e.clientY}px`;
  mouse.set(e.clientX / W * 2 - 1, -(e.clientY / H) * 2 + 1);
  const pr = renderer.getPixelRatio();
  LENS_U.uMouse.value.set(e.clientX * pr, (H - e.clientY) * pr);
  if (e.pointerType === 'mouse') hasMouse = true;
  if (!drag.on) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  const dts = Math.max(.004, (e.timeStamp - drag.t) / 1000);
  drag.x = e.clientX; drag.y = e.clientY; drag.t = e.timeStamp;
  drag.moved += Math.abs(dx) + Math.abs(dy);
  rot.ty += dx * DRAG; rot.tx = clamp(rot.tx + dy * DRAG, -1.1, 1.1);
  // скорость по реальному времени между событиями, сглаженная: частота мыши не важна
  rot.vy = lerp(rot.vy, clamp(dx * DRAG / dts, -MAX_FLING, MAX_FLING), .35);
  rot.vx = lerp(rot.vx, clamp(dy * DRAG / dts, -MAX_FLING, MAX_FLING), .35);
});

addEventListener('pointerup', e => {
  if (!drag.on) return;
  drag.on = false;
  // мышь остановили перед отпусканием - облако не должно улетать
  if (e.timeStamp - drag.t > 80) rot.vx = rot.vy = 0;
  cursor.classList.remove('is-drag');
  // открываем только при честном клике по той же карточке, иначе это было вращение
  if (drag.moved < CLICK_MOVE && e.timeStamp - drag.t0 < CLICK_MS && drag.card && pick(e.clientX, e.clientY) === drag.card) open(drag.card);
  drag.card = null;
});

/* ---------- Открытый кейс ---------- */
function screenRect(k) {
  const p = k.mesh.position.clone().project(camera);
  const dist = camera.position.z - k.mesh.position.z;
  const ppu = H / (2 * Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * dist);
  const w = k.mesh.scale.x * ppu, h = k.mesh.scale.y * ppu;
  return { left: (p.x + 1) / 2 * W - w / 2, top: (1 - p.y) / 2 * H - h / 2, width: w, height: h };
}

const viewer = $('viewer'), vFrames = $('vFrames');
let viewing = null, frameIdx = 0, box = null;

function frameEl(f, on) {
  const el = f.video ? document.createElement('video') : new Image();
  if (f.video) Object.assign(el, { src: f.video, poster: f.poster || '', muted: true, loop: true, playsInline: true, autoplay: true });
  else { el.src = f.img; el.alt = ''; }
  el.className = 'frame' + (on ? ' is-on' : '');
  return el;
}

// вид экрана кейса: выбирается переключателем в открытом кейсе и запоминается в браузере
const CASE_MODES = ['panel', 'cinema', 'poster', 'split', 'strip'];
let caseMode = 'cinema';
try { const m = localStorage.getItem('mb-case'); if (CASE_MODES.includes(m)) caseMode = m; } catch (e) {}

// место под кадр в зависимости от вида
function mediaBox(c) {
  const infoW = Math.min(380, W * .3);
  // кейс начинается под логотипом: он остаётся поверх фона кейса
  const top = Math.round(document.querySelector('.logo').getBoundingClientRect().bottom) + 28;
  viewer.style.setProperty('--viewer-top', top + 'px');
  // постер и сплит на телефоне не помещаются: там они собираются как обычная панель
  const mode = mobile && (caseMode === 'poster' || caseMode === 'split') ? 'panel' : caseMode;
  viewer.dataset.mode = mode;
  [...$('vModes').children].forEach(b => b.classList.toggle('is-on', b.dataset.mode === caseMode));
  if (mode === 'cinema') return { x: 0, y: 0, w: W, h: H };
  if (mode === 'split') return { x: W / 2, y: 0, w: W / 2, h: H };
  if (mode === 'strip') {
    const h = mobile ? H * .36 : H * .5;
    return { x: mobile ? 16 : 32, y: top, w: h * c.ratio, h };
  }
  let area;
  if (mode === 'poster') {
    // название уже стоит во всю ширину: кадр под ним, слева от колонки фактов
    const y = Math.round($('vTitle').getBoundingClientRect().bottom) + 28;
    area = { x: 32, y, w: W - infoW - 32 - 32 - 56, h: H - y - 32 };
    let fw = area.w, fh = fw / c.ratio;
    if (fh > area.h) { fh = area.h; fw = fh * c.ratio; }
    return { x: area.x, y: area.y, w: fw, h: fh };
  }
  area = mobile
    ? { x: 16, y: top, w: W - 32, h: H * .42 }
    : { x: 32, y: top, w: W - infoW - 32 - 32 - 56, h: H - top - 32 };
  let fw = area.w, fh = fw / c.ratio;
  if (fh > area.h) { fh = area.h; fw = fh * c.ratio; }
  return { x: area.x + (mobile ? (area.w - fw) / 2 : 0), y: area.y + (area.h - fh) / 2 * (mobile ? 0 : 1), w: fw, h: fh };
}

// лента: кадры в ряд, тянутся мышью или колесом
let stripX = 0;
function setStrip(x) {
  if (viewer.dataset.mode !== 'strip') { stripX = 0; vMedia.style.translate = ''; return; }
  const max = Math.max(0, vMedia.scrollWidth - (W - box.x - 32));
  stripX = clamp(x, 0, max);
  vMedia.style.translate = `${-stripX}px 0`;
}

function placeBox(b) {
  box = b;
  Object.assign(vMedia.style, { left: b.x + 'px', top: b.y + 'px', width: b.w + 'px', height: b.h + 'px' });
  vMedia.style.setProperty('--fw', b.w + 'px');
  setStrip(0);
  viewer.style.setProperty('--info-top', (b.y + b.h + 20) + 'px');
}

function flipFrom(r) {
  return `translate(${r.left - box.x}px,${r.top - box.y}px) scale(${r.width / box.w},${r.height / box.h})`;
}

function fill(c) {
  viewing = c; frameIdx = 0;
  vMedia.replaceChildren(...c.frames.map((f, i) => frameEl(f, i === 0)));
  $('vIdx').textContent = pad(CASES.indexOf(c) + 1) + ' / ' + pad(CASES.length);
  $('vTitle').textContent = c.title;
  $('vClient').textContent = c.client;
  $('vServices').textContent = c.services.join(', ');
  $('vYear').textContent = c.year;
  $('vDesc').textContent = c.description;
  $('vResults').replaceChildren(...c.results.map(r => {
    const li = document.createElement('li');
    li.innerHTML = '<b></b><span></span>';
    li.firstChild.textContent = r.value; li.lastChild.textContent = r.label;
    return li;
  }));
  vFrames.replaceChildren(...(c.frames.length > 1 ? c.frames.map((f, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-label', `Frame ${i + 1}`);
    b.style.backgroundImage = `url("${f.poster || f.img}")`;
    b.addEventListener('click', () => setFrame(i));
    return b;
  }) : []));
  setFrame(0);
}

function setFrame(i) {
  const n = viewing.frames.length;
  frameIdx = (i + n) % n;
  [...vMedia.children].forEach((el, j) => el.classList.toggle('is-on', j === frameIdx));
  [...vFrames.children].forEach((el, j) => el.classList.toggle('is-on', j === frameIdx));
}

// карточка в облаке, в которую кейс улетит при закрытии
const cardFor = c => cards.find(k => k.c === c) || null;

function open(k) {
  if (opened) return;
  opened = k; openAt = performance.now();
  const r = screenRect(k);
  fill(k.c);
  placeBox(mediaBox(k.c));
  vMedia.style.transition = 'none';
  vMedia.style.transform = flipFrom(r);
  vMedia.style.visibility = 'visible';
  void vMedia.offsetWidth;
  vMedia.style.transition = '';
  vMedia.style.transform = 'none';
  document.body.classList.add('is-open');
  $('vClose').focus({ preventScroll: true });
}

// листание кейсов без возврата в облако
let switching = false;
function go(step) {
  if (!opened || switching) return;
  switching = true;
  const c = CASES[(CASES.indexOf(viewing) + step + CASES.length) % CASES.length];
  viewer.classList.add('is-switching');
  setTimeout(() => {
    fill(c);
    placeBox(mediaBox(c));
    opened = cardFor(c) || { c, mesh: null };
    openAt = performance.now();
    $('vInfo').scrollTop = 0;
    viewer.classList.remove('is-switching');
    switching = false;
  }, 230);
}

function close() {
  if (!opened) return;
  const k = opened;
  openAt = performance.now();             // облако снова рисуется, пока кейс летит обратно
  stripX = 0; vMedia.style.translate = '';
  if (k.mesh) vMedia.style.transform = flipFrom(screenRect(k));
  else vMedia.style.opacity = '0';
  document.body.classList.remove('is-open');
  setTimeout(() => {
    vMedia.style.visibility = 'hidden'; vMedia.style.opacity = ''; vMedia.style.translate = '';
    vMedia.replaceChildren();
    opened = null; hovered = null; viewing = null;
  }, 700);
}

$('vClose').addEventListener('click', close);
$('vModes').addEventListener('click', e => {
  const m = e.target.closest('button')?.dataset.mode;
  if (!m || m === caseMode || !viewing || switching) return;
  caseMode = m;
  try { localStorage.setItem('mb-case', m); } catch (err) {}
  switching = true;
  viewer.classList.add('is-switching');
  setTimeout(() => { placeBox(mediaBox(viewing)); setFrame(frameIdx); viewer.classList.remove('is-switching'); switching = false; }, 230);
});
viewer.addEventListener('wheel', e => {
  if (viewer.dataset.mode !== 'strip' || !opened) return;
  e.preventDefault();
  setStrip(stripX + e.deltaY + e.deltaX);
}, { passive: false });
$('vPrev').addEventListener('click', () => go(-1));
$('vNext').addEventListener('click', () => go(1));
viewer.addEventListener('click', e => { if (e.target === viewer) close(); });

// клик по кадру - следующий кадр; на тач-экранах ещё и свайп
let swipeX = null;
let stripFrom = 0;
vMedia.addEventListener('pointerdown', e => { swipeX = e.clientX; stripFrom = stripX; });
addEventListener('pointermove', e => {
  if (swipeX !== null && viewer.dataset.mode === 'strip') setStrip(stripFrom - (e.clientX - swipeX));
});
vMedia.addEventListener('pointerup', e => {
  if (viewer.dataset.mode === 'strip') { swipeX = null; return; }
  if (swipeX === null || !viewing) return;
  const dx = e.clientX - swipeX; swipeX = null;
  if (Math.abs(dx) > 40) setFrame(frameIdx + (dx < 0 ? 1 : -1));
  else if (viewing.frames.length > 1) setFrame(frameIdx + 1);
});

addEventListener('keydown', e => {
  if (!opened) return;
  if (e.key === 'Escape') close();
  if (e.key === 'ArrowRight') go(1);
  if (e.key === 'ArrowLeft') go(-1);
});

addEventListener('resize', () => { if (viewing) placeBox(mediaBox(viewing)); });

/* ---------- Кадр ---------- */
const m4 = new THREE.Matrix4(), eul = new THREE.Euler(), tmp = new THREE.Vector3();
const fr = { x: 0, y: 0, w: 0, h: 0 };   // текущая рамка видоискателя
let spin = 1;                            // множитель собственного вращения
let prev = performance.now();

function frame(now) {
  // размер окна сверяем каждый кадр: во встроенных окнах событие resize приходит не всегда
  if (innerWidth !== W || innerHeight !== H) fit();
  const dt = Math.min(.05, (now - prev) / 1000); prev = now;

  if (phase === 'intro' && now - phaseAt > 1300 + cards.length * 28) phase = 'live';

  // вращение: своё + инерция после перетаскивания; на открытом кейсе облако замирает
  if (drag.on) {
    // плавное догоняние целевого угла: ровно при любой частоте событий мыши
    const kd = 1 - Math.exp(-dt * 22);
    rot.y = lerp(rot.y, rot.ty, kd);
    rot.x = lerp(rot.x, rot.tx, kd);
  } else if (!opened) {
    const k = Math.exp(-dt * 2.2);
    rot.vy *= k; rot.vx *= k;
    // под захваченной карточкой облако почти замирает, чтобы по ней было легко попасть
    spin = lerp(spin, hovered ? .08 : 1, 1 - Math.exp(-dt * 5));
    rot.y += ((reduced ? 0 : AUTO_SPIN) * spin + rot.vy) * dt;
    rot.x = clamp(rot.x + rot.vx * dt, -1.1, 1.1);
    rot.x = lerp(rot.x, TILT, dt * .25);
  }
  m4.makeRotationFromEuler(eul.set(rot.x, rot.y, 0, 'XYZ'));

  // сжатое облако раздувается, когда курсор подходит к нему; на тач-экранах наведения нет - всегда раскрыто
  const rCompactPx = R_COMPACT * cloudAt.ppu, rOpenPx = R_OPEN * cloudAt.ppu;
  const near = Math.hypot(ptr.x - cloudAt.x, ptr.y - cloudAt.y) < (openK > .5 ? rOpenPx * 1.1 : rCompactPx + 90);
  const active = drag.on || !!hovered || !!opened || (hasMouse && near);
  if (active) activeAt = now;
  // не дёргаем облако туда-сюда: сжимается только через секунду после того, как курсор ушёл
  const wantOpen = !finePointer || active || now - activeAt < 1000;
  openK = lerp(openK, wantOpen && phase !== 'wait' ? 1 : 0, 1 - Math.exp(-dt * 3.2));
  const oe = ease(openK);
  const radius = lerp(R_COMPACT, R_OPEN, oe), size = lerp(SIZE_COMPACT, SIZE_OPEN, oe);

  // наведение
  let hit = null;
  if (!opened && !drag.on && phase === 'live') {
    ray.setFromCamera(mouse, camera);
    const hits = ray.intersectObjects(meshes, false);
    hit = hits.length ? hits[0].object.userData.card : null;
  }
  // пока кнопка зажата без сдвига, это клик, а не перетаскивание: карточку не отпускаем
  const pressing = drag.on && drag.moved < CLICK_MOVE;
  if (!opened && !pressing && hit !== hovered) {
    if (hit && !hovered) {
      // уголки вылетают из точки курсора и защёлкиваются на карточке
      const r = cursor.style.translate.split(' ').map(parseFloat);
      Object.assign(fr, { x: r[0], y: r[1], w: 0, h: 0 });
    }
    hovered = hit;
    cursor.classList.toggle('is-hover', !!hit);
    focus.classList.toggle('is-on', !!hit);
    if (hit) focusLabel.textContent = `${hit.c.title} · ${hit.c.tag}`;
  }
  if (opened) { cursor.classList.remove('is-hover'); focus.classList.remove('is-on'); }

  // видоискатель ездит за захваченной карточкой, пока облако крутится
  if (hovered && !opened) {
    const r = screenRect(hovered), p = 10, k = 1 - Math.exp(-dt * 18);
    fr.x = lerp(fr.x, r.left - p, k); fr.y = lerp(fr.y, r.top - p, k);
    fr.w = lerp(fr.w, r.width + p * 2, k); fr.h = lerp(fr.h, r.height + p * 2, k);
    focus.style.translate = `${fr.x}px ${fr.y}px`;
    focus.style.width = fr.w + 'px';
    focus.style.height = fr.h + 'px';
  }

  // линза: раскрывается, когда мышь над сценой; во время входа и на тач-экранах всё в цвете
  const lensOn = hasMouse && finePointer && !opened && phase === 'live';
  const kl = 1 - Math.exp(-dt * 7);
  LENS_U.uRadius.value = lerp(LENS_U.uRadius.value, lensOn ? LENS * renderer.getPixelRatio() : 0, kl);
  LENS_U.uSoft.value = LENS_SOFT * renderer.getPixelRatio();
  LENS_U.uAll.value = lerp(LENS_U.uAll.value, finePointer && phase === 'live' ? 0 : 1, 1 - Math.exp(-dt * 2.5));

  for (const k of cards) {
    const s = spreadOf(k, now);
    tmp.copy(k.base).multiplyScalar(radius).applyMatrix4(m4);
    k.mesh.position.lerpVectors(ORIGIN, tmp, s);
    // пока картинка не загрузилась, карточку не показываем: иначе на медленной сети видны пустые чёрные плашки
    k.mesh.visible = phase !== 'wait' && k !== opened && !!k.mesh.material.map.userData.loaded;
    k.hover = lerp(k.hover, k === hovered ? 1 : 0, 1 - Math.exp(-dt * 12));
    const sc = size * k.sz * lerp(.3, 1, s) * (1 + k.hover * .08);
    const img = k.mesh.material.map?.image;
    const ratio = img && img.width ? img.width / img.height : k.c.ratio;
    k.mesh.scale.set(sc, sc / ratio, 1);
    k.mesh.material.userData.uHover.value = k.hover;
  }

  // за открытым кейсом облако почти не видно и стоит: после анимации открытия не перерисовываем
  if (!opened || now - openAt < 800) renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

/* ---------- Тема: белая или тёмная, переключатель и ?theme= ---------- */
function themeBg() { return getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#ffffff'; }
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $('themeToggle').textContent = t === 'dark' ? 'Light' : 'Dark';
  try { localStorage.setItem('mb-theme', t); } catch (e) {}
  const bg = themeBg();
  renderer.setClearColor(bg, 1);
  if (scene.fog) scene.fog.color.set(bg);
}
let theme = new URLSearchParams(location.search).get('theme');
if (theme !== 'dark' && theme !== 'light') { try { theme = localStorage.getItem('mb-theme'); } catch (e) {} }
applyTheme(theme === 'dark' ? 'dark' : 'light');
$('themeToggle').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));

mobile = null;
fit();
addEventListener('resize', fit);
// ширина заголовка меняется, когда догрузится шрифт: пересчитываем место под облако
document.fonts.ready.then(fit);
requestAnimationFrame(frame);
