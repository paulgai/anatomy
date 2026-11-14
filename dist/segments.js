import { Mesh, BufferGeometry, BufferAttribute } from 'three';

// The pinned GLBs preserve connected components for both digestive segments.
// Vertex counts uniquely identify the same source components in both bodies.
const segments = [
  { parent: 'small_intestine', key: 'duodenum', vertices: 83 },
  { parent: 'colon', key: 'rectum', vertices: 127 },
];

function findComponent(geometry, vertexCount) {
  const size = geometry.getAttribute('position').count;
  const parent = Array.from({ length: size }, (_, index) => index);
  const root = index => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const indices = geometry.index.array;
  for (let index = 0; index < indices.length; index += 3) {
    const triangleRoot = root(indices[index]);
    parent[root(indices[index + 1])] = triangleRoot;
    parent[root(indices[index + 2])] = triangleRoot;
  }
  const counts = new Map();
  for (let index = 0; index < size; index++) {
    const key = root(index);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const matches = [...counts].filter(([, count]) => count === vertexCount);
  if (matches.length !== 1) throw new Error('Could not identify digestive segment');
  const match = matches[0][0];
  return index => root(index) === match;
}

function subset(geometry, includesVertex) {
  const result = new BufferGeometry();
  const vertices = [];
  const mapping = new Map();
  const indices = [];
  for (const sourceIndex of geometry.index.array) {
    if (!includesVertex(sourceIndex)) continue;
    if (!mapping.has(sourceIndex)) {
      mapping.set(sourceIndex, vertices.length);
      vertices.push(sourceIndex);
    }
    indices.push(mapping.get(sourceIndex));
  }
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    const source = attribute.isInterleavedBufferAttribute ? attribute.data.array : attribute.array;
    const stride = attribute.isInterleavedBufferAttribute ? attribute.data.stride : attribute.itemSize;
    const offset = attribute.isInterleavedBufferAttribute ? attribute.offset : 0;
    const buffer = new source.constructor(vertices.length * attribute.itemSize);
    vertices.forEach((index, target) => {
      const start = index * stride + offset;
      buffer.set(source.subarray(start, start + attribute.itemSize), target * attribute.itemSize);
    });
    result.setAttribute(name, new BufferAttribute(buffer, attribute.itemSize, attribute.normalized));
  }
  result.setIndex(indices);
  result.computeBoundingBox();
  result.computeBoundingSphere();
  return result;
}

export function splitDigestiveSegments(meshes) {
  for (const { parent, key, vertices } of segments) {
    const mesh = meshes.get(parent);
    const source = mesh.geometry;
    const includesVertex = findComponent(source, vertices);
    mesh.geometry = subset(source, index => !includesVertex(index));
    const segment = new Mesh(subset(source, includesVertex), mesh.material);
    segment.name = key;
    segment.position.copy(mesh.position);
    segment.quaternion.copy(mesh.quaternion);
    segment.scale.copy(mesh.scale);
    mesh.parent.add(segment);
    meshes.set(key, segment);
    source.dispose();
  }
}
