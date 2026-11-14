import {
  Box3, Color, DoubleSide, Mesh, MeshBasicMaterial, Raycaster, Scene, Vector2, Vector3, WebGLRenderTarget,
} from 'three';

const ray = new Raycaster();

export function organAnchor(id, parts) {
  // For paired organs, point at one actual mesh, away from the gap between them.
  const mesh = parts[0];
  const bounds = new Box3().setFromObject(mesh);
  const center = bounds.getCenter(new Vector3());
  // The bladder mesh also includes the urethra below the bladder itself.
  if (id === 'bladder') center.y = bounds.max.y - (bounds.max.y - bounds.min.y) * 0.2;
  const vertices = mesh.geometry.getAttribute('position');
  const candidate = new Vector3();
  const anchor = new Vector3();
  let nearest = Infinity;
  for (let index = 0; index < vertices.count; index++) {
    candidate.fromBufferAttribute(vertices, index).applyMatrix4(mesh.matrixWorld);
    const distance = candidate.distanceToSquared(center);
    if (distance < nearest) {
      nearest = distance;
      anchor.copy(candidate);
    }
  }
  return anchor;
}

// Render organ IDs with the same camera and depth test as the visible anatomy.
// A pixel belongs to the organ whose surface is actually in front at that point.
export function createQuizSurfacePicker() {
  const scene = new Scene();
  scene.background = new Color(0);
  const target = new WebGLRenderTarget(1, 1);
  const meshes = new WeakMap();
  const materials = [new MeshBasicMaterial({ color: 0, toneMapped: false, side: DoubleSide })];
  const pointer = new Vector2();
  let pixels = new Uint8Array();

  function addMesh(source, id) {
    materials[id] ??= new MeshBasicMaterial({
      color: new Color().setRGB(id / 255, 0, 0),
      toneMapped: false,
      side: DoubleSide,
    });
    let mesh = meshes.get(source);
    if (!mesh) {
      mesh = new Mesh(source.geometry);
      mesh.matrixAutoUpdate = false;
      meshes.set(source, mesh);
    }
    mesh.material = materials[id];
    mesh.matrix.copy(source.matrixWorld);
    mesh.matrixWorldNeedsUpdate = true;
    scene.add(mesh);
  }

  return (renderer, camera, model, selectedIds, viewWidth, viewHeight) => {
    const ids = [...selectedIds];
    if (!ids.length || !viewWidth || !viewHeight) return [];
    const scale = Math.min(1, 384 / Math.max(viewWidth, viewHeight));
    const width = Math.max(1, Math.round(viewWidth * scale));
    const height = Math.max(1, Math.round(viewHeight * scale));
    if (width !== target.width || height !== target.height) target.setSize(width, height);
    if (pixels.length !== width * height * 4) pixels = new Uint8Array(width * height * 4);
    scene.clear();
    ids.forEach((id, index) => {
      for (const part of model.drawables.get(id)) addMesh(part, index + 1);
    });
    if (model.skin.visible && model.skin.material.opacity === 1) addMesh(model.skin, 0);

    const previous = renderer.getRenderTarget();
    try {
      renderer.setRenderTarget(target);
      renderer.clear();
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
    } finally {
      renderer.setRenderTarget(previous);
    }

    const preferred = ids.map(id => model.anchors.get(id).clone().project(camera));
    const candidates = ids.map(() => []);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;
        const index = pixels[offset] - 1;
        if (index < 0 || index >= ids.length) continue;
        const ndcX = (x + 0.5) / width * 2 - 1;
        const ndcY = (y + 0.5) / height * 2 - 1;
        const distance = ((ndcX - preferred[index].x) * width) ** 2
          + ((ndcY - preferred[index].y) * height) ** 2;
        const interior = x > 0 && y > 0 && x < width - 1 && y < height - 1
          && [-4, 4, -width * 4, width * 4].every(delta => pixels[offset + delta] === index + 1);
        const score = distance + (interior ? 0 : 64);
        const list = candidates[index];
        if (list.length === 5 && score >= list[4].score) continue;
        list.push({ ndcX, ndcY, score });
        list.sort((a, b) => a.score - b.score);
        if (list.length > 5) list.pop();
      }
    }

    const visible = ids.flatMap(id => model.drawables.get(id));
    if (model.skin.visible && model.skin.material.opacity === 1) visible.push(model.skin);
    return ids.map((id, index) => {
      const parts = model.drawables.get(id);
      for (const { ndcX, ndcY } of candidates[index]) {
        ray.setFromCamera(pointer.set(ndcX, ndcY), camera);
        const hit = ray.intersectObjects(visible, false)[0];
        if (hit && parts.includes(hit.object)) {
          return { number: index + 1, point: hit.point.project(camera), color: parts[0].material.color.getStyle() };
        }
      }
      return { number: index + 1 };
    });
  };
}

export function drawQuizOverlay(canvas, camera, body, surfaces, insets) {
  const { clientWidth: width, clientHeight: height } = canvas;
  if (!width || !height) return [];
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.round(width * pixelRatio);
  const pixelHeight = Math.round(height * pixelRatio);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (!surfaces.length) return [];

  const toPixel = point => ({ x: (point.x + 1) * width / 2, y: (1 - point.y) * height / 2 });
  const bodyXs = [];
  for (const x of [body.min.x, body.max.x]) {
    for (const y of [body.min.y, body.max.y]) {
      for (const z of [body.min.z, body.max.z]) {
        const point = new Vector3(x, y, z).project(camera);
        if (point.z < 1) bodyXs.push(toPixel(point).x);
      }
    }
  }
  const left = Math.max(17, Math.min(width * 0.24, Math.min(...bodyXs) - 20));
  const right = Math.min(width - 17, Math.max(width * 0.76, Math.max(...bodyXs) + 20));
  const columns = [[], []];
  const hiddenNumbers = [];
  for (const { number, point, color } of surfaces) {
    if (!point) {
      hiddenNumbers.push(number);
      continue;
    }
    const anchor = toPixel(point);
    columns[anchor.x < width / 2 ? 0 : 1].push({ anchor, number, color });
  }

  const top = insets.top + 16;
  const bottom = Math.max(top, height - insets.bottom - 16);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.font = 'bold 13px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  columns.forEach((items, side) => {
    items.sort((a, b) => a.anchor.y - b.anchor.y);
    const gap = Math.min(31, (bottom - top) / Math.max(1, items.length - 1));
    const radius = Math.min(13, Math.max(9, gap / 2 - 1));
    const x = side ? right : left;
    const outward = side ? 1 : -1;
    let previous = top - gap;
    items.forEach(({ anchor, number, color }, index) => {
      const y = Math.max(previous + gap, Math.min(anchor.y, bottom - gap * (items.length - 1 - index)));
      previous = y;
      const tip = x - outward * (radius + 2);
      const bend = tip - outward * 10;
      ctx.beginPath();
      ctx.moveTo(anchor.x, anchor.y);
      ctx.lineTo(bend, y);
      ctx.lineTo(tip, y);
      ctx.moveTo(tip - outward * 6, y - 4);
      ctx.lineTo(tip, y);
      ctx.lineTo(tip - outward * 6, y + 4);
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#101720';
      ctx.stroke();
      ctx.lineWidth = 1.8;
      ctx.strokeStyle = '#b6f4df';
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(anchor.x, anchor.y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = '#b6f4df';
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#101720';
      ctx.fillText(String(number), x, y + 0.5);
    });
  });
  return hiddenNumbers;
}
