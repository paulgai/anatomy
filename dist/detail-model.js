import { Box3, Vector3 } from 'three';

export function createDetailLoader(loader) {
  let pending;
  return async (meshes, sex) => {
    pending ??= loader.loadAsync('./assets/bodyparts-detail.glb')
      .then(({ scene }) => {
        const parts = new Map();
        scene.traverse(mesh => {
          if (!mesh.isMesh) return;
          mesh.geometry.computeVertexNormals();
          parts.set(mesh.name, mesh);
        });
        return parts;
      })
      .catch(error => {
        pending = undefined;
        throw error;
      });

    for (const [key, source] of await pending) {
      if (sex === 'female' && key === 'skin') continue;
      const original = meshes.get(key);
      const detail = source.clone();
      if (sex === 'female') {
        // Fit each BodyParts3D organ to the female atlas's existing placement.
        const target = new Box3().setFromObject(original);
        const bounds = new Box3().setFromObject(source);
        const scale = target.getSize(new Vector3()).divide(bounds.getSize(new Vector3()));
        detail.scale.copy(scale);
        detail.position.copy(target.getCenter(new Vector3()))
          .sub(bounds.getCenter(new Vector3()).multiply(scale));
      }
      detail.visible = false;
      original.parent.add(detail);
      original.removeFromParent();
      meshes.set(key, detail);
    }
  };
}
