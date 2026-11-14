import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { GLTFLoader } from './vendor/loaders/GLTFLoader.js';
import { MeshoptDecoder } from './vendor/meshopt_decoder.module.js';
import { organs, regions } from './organs.js';
import { splitDigestiveSegments } from './segments.js';
import { createDetailLoader } from './detail-model.js';
import { createQuizSurfacePicker, drawQuizOverlay, moveQuizAnchor, organAnchor } from './quiz-overlay.js';

const byId = id => document.getElementById(id);
const viewer = byId('viewer');
const status = byId('status');
const modelSelect = byId('body');
const opacity = byId('opacity');
const search = byId('search');
const organCatalog = byId('organ-catalog');
const quizOverlay = byId('quiz-overlay');
const quizOcclusion = byId('quiz-occlusion');
const viewerControls = viewer.querySelector('.views');
const viewerFooter = viewer.querySelector('.viewer-bottom');
const quizTemplate = byId('quiz-template');
const quizzes = Array.from({ length: 4 }, (_, index) => {
  const panel = quizTemplate.content.firstElementChild.cloneNode(true);
  const title = 'Quiz ' + (index + 1);
  const preview = panel.querySelector('.quiz-preview');
  panel.querySelector('.quiz-title').textContent = title;
  preview.setAttribute('aria-label', 'Εμφάνιση βελών · ' + title);
  quizTemplate.before(panel);
  return {
    details: panel.querySelector('details'),
    count: panel.querySelector('.quiz-count'),
    rows: panel.querySelector('.quiz-regions'),
    preview,
    selection: new Set(),
    anchorsByModel: new WeakMap(),
  };
});
let previewQuiz;
const pickQuizSurfaces = createQuizSurfacePicker();
const activeQuiz = () => organCatalog.open ? undefined : quizzes.find(quiz => quiz.details.open) ?? previewQuiz;
const selectionForModel = quiz => new Set([...quiz.selection].filter(id => activeModel?.drawables.has(id)));
function manualAnchors(quiz, model) {
  if (!quiz.anchorsByModel.has(model)) quiz.anchorsByModel.set(model, new Map());
  return quiz.anchorsByModel.get(model);
}
let quizHandles = [];
const viewButtons = [...document.querySelectorAll('[data-view]')];
const directions = {
  front: new THREE.Vector3(0, 0, 1),
  back: new THREE.Vector3(0, 0, -1),
  side: new THREE.Vector3(1, 0, 0),
};
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.005, 20);
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const attachDetailMeshes = createDetailLoader(loader);
const cache = new Map();
let lobeData;

async function attachLungLobes(meshes, sex) {
  lobeData ??= fetch('./assets/lung-lobes.json').then(response => {
    if (!response.ok) throw new Error('Lung meshes unavailable');
    return response.json();
  }).catch(error => {
    lobeData = undefined;
    throw error;
  });
  for (const [key, data] of Object.entries(await lobeData)) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(data.position, 3));
    geometry.setIndex(data.index);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry);
    mesh.name = key;
    // Register the atlas frames with the common thoracic landmarks.
    mesh.position.set(0.002, 0.005, -0.004);
    if (sex === 'female') {
      mesh.scale.set(0.97, 0.87, 0.76);
      mesh.position.set(-0.003, 0.084, -0.011);
    }
    const airway = meshes.get(key.startsWith('left') ? 'lung_l' : 'lung_r');
    airway.parent.add(mesh);
    meshes.set(key, mesh);
  }
}
const raycaster = new THREE.Raycaster();
const allIds = new Set(organs.map(organ => organ.id));
let visible = new Set(allIds);
let activeModel;
let activeOrgans = [];
let selected;
let isolated = false;
let requestedModel = 0;
let renderer;
let controls;
let renderPending = false;

const skinMaterial = new THREE.MeshPhysicalMaterial({
  color: '#7cadc4', roughness: 0.58, transparent: true, depthWrite: false,
  side: THREE.DoubleSide, forceSinglePass: true, depthFunc: THREE.EqualDepth,
});
// Write only the nearest surface depth, after opaque organs and before skin color.
const skinDepthMaterial = new THREE.MeshBasicMaterial({
  transparent: true, colorWrite: false, side: THREE.DoubleSide, forceSinglePass: true,
});
scene.add(new THREE.HemisphereLight('#e5f4ff', '#8d6058', 2.1));
for (const [color, power, position] of [
  ['#fff4e7', 2.25, [2, 3, 4]],
  ['#a7d6ff', 2.6, [-2, 2, -3]],
]) {
  const light = new THREE.DirectionalLight(color, power);
  light.position.set(...position);
  scene.add(light);
}

function render() {
  if (!renderer || renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    renderer.render(scene, camera);
    const quiz = activeQuiz();
    if (quiz && activeModel) {
      const surfaces = pickQuizSurfaces(renderer, camera, activeModel, selectionForModel(quiz),
        manualAnchors(quiz, activeModel), viewer.clientWidth, viewer.clientHeight);
      quizHandles = surfaces.filter(surface => surface.point);
      const hiddenNumbers = drawQuizOverlay(quizOverlay, camera, activeModel.bodyBounds, surfaces, {
        top: viewerControls.offsetTop + viewerControls.offsetHeight,
        bottom: viewer.clientHeight - viewerFooter.offsetTop,
      });
      quizOcclusion.hidden = !hiddenNumbers.length;
      const hint = 'Εκτός ορατής επιφάνειας · ' + hiddenNumbers.join(', ');
      if (quizOcclusion.textContent !== hint) quizOcclusion.textContent = hint;
    }
  });
}

function tissueMaterial(color) {
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.74, side: THREE.DoubleSide });
  material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTissuePosition;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTissuePosition = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vTissuePosition;
        float tissueHash(vec3 p) { return fract(sin(dot(p, vec3(127.1,311.7,74.7))) * 43758.5453); }
        float tissueNoise(vec3 p) {
          vec3 i = floor(p), f = fract(p);
          f = f*f*(3.0-2.0*f);
          vec2 o = vec2(1.0,0.0);
          return mix(
            mix(mix(tissueHash(i), tissueHash(i+o.xyy),f.x),mix(tissueHash(i+o.yxy),tissueHash(i+o.xxy),f.x),f.y),
            mix(mix(tissueHash(i+o.yyx),tissueHash(i+o.xyx),f.x),mix(tissueHash(i+o.yxx),tissueHash(i+o.xxx),f.x),f.y),f.z);
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float broad = tissueNoise(vTissuePosition * 54.0) - 0.5;
        float fine = tissueNoise(vTissuePosition * 570.0) - 0.5;
        float detail = 1.0 - smoothstep(0.6, 1.8, length(fwidth(vTissuePosition * 570.0)));
        diffuseColor.rgb *= 1.0 + 0.27*broad + 0.22*fine*detail;`);
  };
  return material;
}

function adjustSmallIntestine(mesh) {
  // Keep the upper edge in place so the reduced loops open up the pelvis below.
  mesh.geometry.computeBoundingBox();
  const bounds = mesh.geometry.boundingBox;
  const pivot = bounds.getCenter(new THREE.Vector3());
  pivot.y = bounds.max.y;
  const offset = pivot.multiply(mesh.scale).applyQuaternion(mesh.quaternion);
  mesh.position.addScaledVector(offset, 0.1);
  mesh.scale.multiplyScalar(0.9);
}

function queueModel(sex) {
  if (!cache.has(sex)) {
    cache.set(sex, loader.loadAsync('./assets/anatomy-' + sex + '.glb')
      .then(async ({ scene: root, parser }) => {
        root.updateMatrixWorld(true);
        const meshes = new Map();
        root.traverse(mesh => {
          if (!mesh.isMesh) return;
          const association = parser.associations.get(mesh);
          const key = parser.json.nodes[association?.nodes]?.name ?? mesh.name;
          meshes.set(key, mesh);
          mesh.visible = false;
        });
        splitDigestiveSegments(meshes);
        await Promise.all([attachLungLobes(meshes, sex), attachDetailMeshes(meshes, sex)]);
        adjustSmallIntestine(meshes.get('small_intestine'));
        const skin = meshes.get('skin');
        if (!skin) throw new Error('Missing skin mesh');
        skin.material = skinMaterial;
        skin.renderOrder = 3;
        const skinDepth = skin.clone();
        skinDepth.material = skinDepthMaterial;
        skinDepth.renderOrder = 2;
        skinDepth.visible = true;
        skin.add(skinDepth);
        skinDepth.position.set(0, 0, 0);
        skinDepth.quaternion.identity();
        skinDepth.scale.setScalar(1);
        const materials = new Map();
        const drawables = new Map();

        for (const organ of organs.filter(item => !item.sex || item.sex === sex)) {
          const material = tissueMaterial(organ.color);
          materials.set(organ.id, material);
          const parts = organ.keys.map(key => meshes.get(key)).filter(Boolean);
          if (parts.length !== organ.keys.length) throw new Error('Missing mesh for ' + organ.id);
          for (const part of parts) {
            part.material = material;
            part.userData.organId = organ.id;
          }
          drawables.set(organ.id, parts);
        }
        root.updateMatrixWorld(true);
        const anchors = new Map([...drawables].map(([id, parts]) => [id, organAnchor(id, parts)]));
        const bodyBounds = new THREE.Box3().setFromObject(skin);
        const organSurfaces = [...drawables.values()].flat();
        const opaqueSurfaces = [...organSurfaces, skin];
        return { root, skin, materials, drawables, anchors, bodyBounds, organSurfaces, opaqueSurfaces };
      })
      .catch(error => {
        cache.delete(sex);
        throw error;
      }));
  }
  return cache.get(sex);
}

function fit(bounds, direction, padding) {
  if (!controls || bounds.isEmpty()) return;
  const target = bounds.getCenter(new THREE.Vector3());
  const radius = bounds.getSize(new THREE.Vector3()).length() / 2;
  const vertical = THREE.MathUtils.degToRad(camera.fov / 2);
  const halfFov = Math.min(vertical, Math.atan(Math.tan(vertical) * camera.aspect));
  const distance = Math.min(controls.maxDistance, Math.max(0.09, radius * padding / Math.sin(halfFov)));
  camera.position.copy(target).addScaledVector(direction, distance);
  controls.target.copy(target);
  controls.update();
  render();
}

function overview(direction = directions.front) {
  if (!activeModel) return;
  const bounds = new THREE.Box3();
  for (const parts of activeModel.drawables.values()) {
    for (const part of parts) bounds.expandByObject(part);
  }
  bounds.min.y -= 0.11;
  bounds.max.y += 0.13;
  fit(bounds, direction, activeQuiz() ? 1.36 : 1.15);
}

function resize() {
  const { clientWidth: width, clientHeight: height } = viewer;
  if (!width || !height) return;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
  render();
}

function updateAxes() {
  const direction = camera.position.clone().sub(controls.target).normalize();
  const view = Object.keys(directions).find(key => direction.dot(directions[key]) > 0.9999);
  for (const button of viewButtons) button.setAttribute('aria-pressed', String(button.dataset.view === view));
  byId('axes').hidden = view !== 'front' && view !== 'back';
  byId('axis-left').textContent = view === 'back' ? 'Α' : 'Δ';
  byId('axis-right').textContent = view === 'back' ? 'Δ' : 'Α';
}

function updateOpacity() {
  const transparency = Number(opacity.value);
  byId('opacity-value').value = transparency + '%';
  skinMaterial.opacity = 1 - transparency / 100;
  if (activeModel) activeModel.skin.visible = transparency < 100;
  render();
}

function normalized(text) {
  return text.toLocaleLowerCase('el').normalize('NFD').replace(/\p{M}/gu, '').replaceAll('ς', 'σ');
}

function updateRows() {
  const root = byId('regions');
  const previousFocus = document.activeElement?.dataset.control;
  root.replaceChildren();
  const query = normalized(search.value.trim());
  for (const region of regions) {
    const members = activeOrgans.filter(organ => organ.region === region.id);
    const matches = members.filter(organ => normalized(organ.name + ' ' + organ.latin + ' ' + region.label).includes(query));
    if (!matches.length) continue;
    const section = document.createElement('section');
    section.className = 'region';
    const header = document.createElement('label');
    header.className = 'region-head';
    const groupToggle = document.createElement('input');
    groupToggle.type = 'checkbox';
    groupToggle.dataset.control = region.id;
    const count = members.filter(organ => visible.has(organ.id)).length;
    groupToggle.checked = count === members.length;
    groupToggle.indeterminate = count > 0 && count < members.length;
    groupToggle.addEventListener('change', () => {
      isolated = false;
      for (const { id } of members) {
        if (groupToggle.checked) visible.add(id);
        else visible.delete(id);
      }
      update();
    });
    header.append(groupToggle, region.label);
    section.append(header);
    for (const organ of matches) {
      const row = document.createElement('div');
      row.className = 'organ-row';
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.dataset.control = organ.id + '-visibility';
      toggle.checked = visible.has(organ.id);
      toggle.setAttribute('aria-label', 'Εμφάνιση · ' + organ.name);
      toggle.addEventListener('change', () => {
        isolated = false;
        if (toggle.checked) visible.add(organ.id);
        else visible.delete(organ.id);
        update();
      });
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.control = organ.id;
      button.setAttribute('aria-pressed', String(selected === organ));
      button.addEventListener('click', () => selectOrgan(organ));
      const swatch = document.createElement('span');
      swatch.className = 'dot';
      swatch.style.background = organ.color;
      button.append(swatch, organ.name);
      row.append(toggle, button);
      section.append(row);
    }
    root.append(section);
  }
  if (!root.childElementCount && activeModel) root.textContent = 'Δεν βρέθηκαν όργανα.';
  if (previousFocus) root.querySelector('[data-control="' + CSS.escape(previousFocus) + '"]')?.focus();
}

function updateQuizRows(quiz) {
  const root = quiz.rows;
  const previousFocus = root.contains(document.activeElement) ? document.activeElement.dataset.control : undefined;
  const numbers = new Map([...selectionForModel(quiz)].map((id, index) => [id, index + 1]));
  quiz.count.textContent = numbers.size;
  quiz.count.hidden = !numbers.size;
  quiz.preview.checked = previewQuiz === quiz;
  if (!quiz.details.open) return;
  root.replaceChildren();
  for (const region of regions) {
    const members = activeOrgans.filter(organ => organ.region === region.id);
    if (!members.length) continue;
    const section = document.createElement('section');
    section.className = 'region';
    const heading = document.createElement('p');
    heading.className = 'region-head';
    heading.textContent = region.label;
    section.append(heading);
    for (const organ of members) {
      const row = document.createElement('label');
      row.className = 'organ-row quiz-row';
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.dataset.control = organ.id;
      toggle.checked = numbers.has(organ.id);
      toggle.addEventListener('change', () => {
        if (toggle.checked) quiz.selection.add(organ.id);
        else quiz.selection.delete(organ.id);
        update();
      });
      const number = document.createElement('span');
      number.className = 'quiz-number';
      number.textContent = numbers.get(organ.id) ?? '';
      number.setAttribute('aria-hidden', 'true');
      row.append(toggle, organ.name, number);
      section.append(row);
    }
    root.append(section);
  }
  if (previousFocus) root.querySelector('[data-control="' + CSS.escape(previousFocus) + '"]')?.focus();
}

function update() {
  const quiz = activeQuiz();
  const quizActive = Boolean(quiz);
  quizHandles = [];
  byId('organ-details').hidden = quizActive;
  quizOverlay.hidden = !quizActive;
  if (!quizActive) quizOcclusion.hidden = true;
  viewer.classList.toggle('quiz-active', quizActive);
  if (activeModel) {
    for (const [id, parts] of activeModel.drawables) {
      const highlighted = !quizActive && id === selected?.id;
      const material = activeModel.materials.get(id);
      material.emissive.set(highlighted ? '#b97658' : '#000000');
      material.emissiveIntensity = highlighted ? 0.34 : 0;
      const shown = quizActive || (isolated ? highlighted : visible.has(id));
      for (const part of parts) part.visible = shown;
    }
  }
  byId('region-name').textContent = regions.find(region => region.id === selected?.region)?.label ?? 'Εξερεύνηση';
  byId('organ-name').textContent = selected?.name ?? 'Επίλεξε ένα όργανο';
  byId('latin').textContent = selected?.latin ?? '';
  byId('description').textContent = selected?.description ?? 'Επίλεξε ένα όργανο από τη λίστα ή πάτησέ το πάνω στο μοντέλο για να δεις τη θέση και τη λειτουργία του.';
  byId('focus').disabled = !selected;
  byId('isolate').disabled = !selected;
  byId('isolate').setAttribute('aria-pressed', String(isolated));
  byId('isolate').textContent = isolated ? 'Τέλος απομόνωσης' : 'Απομόνωση οργάνου';
  updateRows();
  for (const entry of quizzes) updateQuizRows(entry);
  render();
}

function selectOrgan(organ) {
  selected = organ;
  visible.add(organ.id);
  update();
}

async function switchModel(sex) {
  const request = ++requestedModel;
  status.textContent = 'Φόρτωση ανατομικού μοντέλου…';
  status.hidden = false;
  try {
    const model = await queueModel(sex);
    if (request !== requestedModel) return;
    if (activeModel) scene.remove(activeModel.root);
    activeModel = model;
    activeOrgans = organs.filter(organ => model.drawables.has(organ.id));
    if (!activeOrgans.includes(selected)) selected = undefined;
    if (!selected) isolated = false;
    scene.add(model.root);
    updateOpacity();
    update();
    overview();
    status.hidden = true;
  } catch (error) {
    if (request !== requestedModel) return;
    console.error(error);
    status.textContent = 'Η φόρτωση του μοντέλου απέτυχε. Δοκίμασε να αλλάξεις μοντέλο ή να ανανεώσεις τη σελίδα.';
  }
}

byId('sources').addEventListener('click', () => byId('source-dialog').showModal());
search.addEventListener('input', updateRows);
organCatalog.addEventListener('toggle', update);
for (const quiz of quizzes) {
  const fitQuiz = () => {
    const direction = controls ? camera.position.clone().sub(controls.target).normalize() : directions.front;
    overview(direction);
  };
  quiz.details.addEventListener('toggle', () => {
    update();
    if (quiz.details.open) fitQuiz();
  });
  quiz.preview.addEventListener('change', () => {
    previewQuiz = quiz.preview.checked ? quiz : undefined;
    if (previewQuiz) {
      organCatalog.open = false;
      for (const entry of quizzes) entry.details.open = false;
    }
    update();
    if (previewQuiz) fitQuiz();
  });
}
modelSelect.addEventListener('change', () => { if (renderer) switchModel(modelSelect.value); });
opacity.addEventListener('input', updateOpacity);
for (const button of viewButtons) {
  button.addEventListener('click', () => {
    if (!controls) return;
    const distance = camera.position.distanceTo(controls.target);
    camera.position.copy(controls.target).addScaledVector(directions[button.dataset.view], distance);
    controls.update();
    updateAxes();
    render();
  });
}
byId('reset').addEventListener('click', () => overview());
byId('full-body').addEventListener('click', () => {
  if (!activeModel) return;
  const bounds = new THREE.Box3().setFromObject(activeModel.skin);
  fit(bounds, camera.position.clone().sub(controls.target).normalize(), 1.1);
});
byId('show-all').addEventListener('click', () => {
  visible = new Set(allIds);
  isolated = false;
  update();
});
byId('isolate').addEventListener('click', () => {
  isolated = !isolated;
  update();
});
byId('focus').addEventListener('click', () => {
  if (!selected || !activeModel) return;
  const bounds = new THREE.Box3();
  for (const part of activeModel.drawables.get(selected.id)) bounds.expandByObject(part);
  fit(bounds, camera.position.clone().sub(controls.target).normalize(), 1.33);
});

function start() {
  try {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  } catch (error) {
    status.textContent = 'Η 3D προβολή χρειάζεται ενεργό WebGL 2 στον browser.';
    console.error(error);
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.04;
  viewer.prepend(renderer.domElement);
  camera.position.set(0, 1.08, 1.3);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1.08, 0);
  controls.minDistance = 0.045;
  controls.maxDistance = 6.5;
  controls.addEventListener('change', () => { updateAxes(); render(); });
  controls.update();
  new ResizeObserver(resize).observe(viewer);
  resize();

  const canvas = renderer.domElement;
  let anchorDrag;
  function pointerPosition(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width * 2 - 1,
      y: 1 - (event.clientY - rect.top) / rect.height * 2 };
  }
  function handleAt(point) {
    let closest;
    let distance = 12;
    for (const handle of quizHandles) {
      const pixels = Math.hypot((handle.point.x - point.x) * canvas.clientWidth / 2,
        (handle.point.y - point.y) * canvas.clientHeight / 2);
      if (pixels < distance) {
        closest = handle;
        distance = pixels;
      }
    }
    return closest;
  }

  // Capture the handle press before OrbitControls starts rotating the model.
  canvas.addEventListener('pointerdown', event => {
    const quiz = activeQuiz();
    if (!quiz || !activeModel || !event.isPrimary || event.button !== 0) return;
    const point = pointerPosition(event);
    const handle = handleAt(point);
    if (!handle) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    anchorDrag = { quiz, model: activeModel, id: handle.id, pointerId: event.pointerId,
      offsetX: handle.point.x - point.x, offsetY: handle.point.y - point.y };
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add('moving-quiz-anchor');
  }, true);
  canvas.addEventListener('pointermove', event => {
    const point = pointerPosition(event);
    canvas.classList.toggle('over-quiz-anchor', !anchorDrag && Boolean(handleAt(point)));
    if (anchorDrag?.pointerId !== event.pointerId) return;
    const { quiz, model, id, offsetX, offsetY } = anchorDrag;
    if (quiz !== activeQuiz() || model !== activeModel) return;
    const position = moveQuizAnchor(camera, model, id, point.x + offsetX, point.y + offsetY);
    if (!position) return;
    manualAnchors(quiz, model).set(id, position);
    render();
  });
  function finishAnchorDrag(event) {
    if (anchorDrag?.pointerId !== event.pointerId) return;
    anchorDrag = undefined;
    canvas.classList.remove('moving-quiz-anchor');
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  }
  canvas.addEventListener('pointerup', finishAnchorDrag);
  canvas.addEventListener('pointercancel', finishAnchorDrag);
  canvas.addEventListener('lostpointercapture', finishAnchorDrag);

  let pointerStart;
  renderer.domElement.addEventListener('pointerdown', event => {
    pointerStart = event.isPrimary && event.button === 0 ? [event.clientX, event.clientY] : undefined;
  });
  renderer.domElement.addEventListener('pointercancel', () => { pointerStart = undefined; });
  renderer.domElement.addEventListener('pointerup', event => {
    const startPoint = pointerStart;
    pointerStart = undefined;
    if (!startPoint || !event.isPrimary || event.button !== 0 || !activeModel || activeQuiz()) return;
    if (Math.hypot(event.clientX - startPoint[0], event.clientY - startPoint[1]) > 5) return;
    const rect = renderer.domElement.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2(
      (event.clientX - rect.left) / rect.width * 2 - 1,
      -(event.clientY - rect.top) / rect.height * 2 + 1,
    ), camera);
    const candidates = [...activeModel.drawables.values()].flat().filter(part => part.visible);
    const hit = raycaster.intersectObjects(candidates, false)[0];
    if (hit) selectOrgan(activeOrgans.find(organ => organ.id === hit.object.userData.organId));
  });

  switchModel(modelSelect.value);
}
start();


