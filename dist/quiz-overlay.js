import { Box3, Raycaster, Vector2, Vector3 } from 'three';

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

export function drawQuizOverlay(canvas, camera, model, selectedIds, insets) {
  const { clientWidth: width, clientHeight: height } = canvas;
  if (!width || !height) return;
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
  if (!model || !selectedIds.size) return;

  const toPixel = point => ({ x: (point.x + 1) * width / 2, y: (1 - point.y) * height / 2 });
  const body = model.bodyBounds;
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
  let number = 0;
  for (const id of selectedIds) {
    number++;
    const parts = model.drawables.get(id);
    if (!parts) continue;
    let point = model.anchors.get(id).clone().project(camera);
    if (Math.abs(point.x) > 1 || Math.abs(point.y) > 1 || Math.abs(point.z) > 1) continue;
    ray.setFromCamera(new Vector2(point.x, point.y), camera);
    const hit = ray.intersectObjects(parts, false)[0];
    if (hit) point = hit.point.project(camera);
    const anchor = toPixel(point);
    columns[anchor.x < width / 2 ? 0 : 1].push({ anchor, number });
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
    items.forEach(({ anchor, number }, index) => {
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
      ctx.fillStyle = '#b6f4df';
      ctx.beginPath();
      ctx.arc(anchor.x, anchor.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#101720';
      ctx.fillText(String(number), x, y + 0.5);
    });
  });
}
