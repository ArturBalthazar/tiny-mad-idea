/**
 * Three.js scene: procedural sphere viewed from inside,
 * tile destruction, 3D guitar-hero notes.
 */
import * as THREE from 'three';

/* ─── Guitar-hero 3D constants ─── */
export const GH3D = {
  CATCH_Z: -2,
  SPAWN_Z: -40,
  NOTE_Y: -1.5,
  X_MIN: -2.5,
  X_MAX: 2.5,
  NOTE_R: 0.12,
  MARKER_R: 0.18,
};

export class Scene3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.sphereMesh = null;
    this.sphereGeo = null;
    this.originalPositions = null;
    this.intactIndices = [];
    this.fallingTiles = [];
    this.material = null;
    this.sphereRotationY = 0;
    this.sphereRotationX = 0;

    // Guitar hero 3D elements
    this.ghActive = false;
    this.ghLaneLines = [];
    this.ghCatchLine = null;
    this.marker = null;
    this.noteGeo = null;
    this.noteDiscGeo = null;

    // Guitar hero fade-in
    this.ghFadeIn = 0;       // 0 → 1 over GH_FADE_DURATION
    this.ghFadeDuration = 1.5; // seconds
  }

  init() {
    const w = window.innerWidth;
    const h = window.innerHeight;

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
    });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 1);
    // NO tone mapping — ACES was making everything gray

    this.scene = new THREE.Scene();

    // Camera
    this.camera = new THREE.PerspectiveCamera(65, w / h, 0.1, 200);
    this.camera.position.set(0, 0, 0);
    this.camera.rotation.set(-0.3, 0, 0); // tilt down from the start — same view as guitar hero

    // Lighting — very bright so BackSide triangles read as WHITE
    // High ambient ensures base brightness, directionals add subtle facet variation
    const ambient = new THREE.AmbientLight(0xffffff, 1.5);
    this.scene.add(ambient);

    const dir1 = new THREE.DirectionalLight(0xffffff, 0.8);
    dir1.position.set(2, 3, 1);
    this.scene.add(dir1);

    const dir2 = new THREE.DirectionalLight(0xffffff, 0.6);
    dir2.position.set(-2, -1, -2);
    this.scene.add(dir2);

    const dir3 = new THREE.DirectionalLight(0xffffff, 0.4);
    dir3.position.set(0, -3, 2);
    this.scene.add(dir3);

    this._buildSphere();
    this._prepareNoteGeometry();

    window.addEventListener('resize', () => this._onResize());
  }

  /* ─── Sphere ─── */

  _buildSphere() {
    const baseGeo = new THREE.IcosahedronGeometry(80, 4);

    // Perturb vertices BEFORE toNonIndexed so shared edge vertices
    // stay matched — no gaps between triangles
    const pos = baseGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const len = Math.sqrt(x * x + y * y + z * z);
      const r = 80 + (Math.random() - 0.5) * 8;
      pos.setXYZ(i, (x / len) * r, (y / len) * r, (z / len) * r);
    }

    this.sphereGeo = baseGeo.toNonIndexed();
    this.sphereGeo.computeVertexNormals();
    this.originalPositions = new Float32Array(this.sphereGeo.attributes.position.array);

    // MeshPhongMaterial + flatShading = faceted white triangles
    // Emissive lifts the darkest faces so nothing reads as gray
    this.material = new THREE.MeshPhongMaterial({
      color: 0xffffff,
      emissive: 0x888888,
      flatShading: true,
      side: THREE.BackSide,
      shininess: 5,
    });

    this.sphereMesh = new THREE.Mesh(this.sphereGeo, this.material);
    this.scene.add(this.sphereMesh);

    const triCount = this.sphereGeo.attributes.position.count / 3;
    this.intactIndices = [];
    for (let i = 0; i < triCount; i++) this.intactIndices.push(i);
  }

  /* ─── Note geometry ─── */

  _prepareNoteGeometry() {
    this.noteGeo = new THREE.SphereGeometry(GH3D.NOTE_R, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    this.noteDiscGeo = new THREE.CircleGeometry(GH3D.NOTE_R, 12);
    this.noteDiscGeo.rotateX(Math.PI / 2);
  }

  /* ─── FOV ─── */

  setFOV(fov) {
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  /* ─── Blob portal (amoeba clip-path) ─── */

  setBlobPortal(fraction, time) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const cx = w / 2;
    const cy = h * 0.8; // 20% from bottom

    if (fraction <= 0.001) {
      this.canvas.style.clipPath = 'polygon(0 0,0 0,0 0)';
      return;
    }
    if (fraction >= 0.95) {
      this.canvas.style.clipPath = 'none';
      return;
    }

    const maxDist = Math.sqrt(
      Math.max(cx, w - cx) ** 2 + Math.max(cy, h - cy) ** 2,
    );
    const baseR = fraction * maxDist * 1.05;
    const wobble = baseR * 0.05;
    const n = 128;
    const pts = [];

    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r =
        baseR +
        Math.sin(3 * a + time * 0.7) * wobble +
        Math.sin(5 * a - time * 1.1) * wobble * 0.6 +
        Math.sin(7 * a + time * 0.4) * wobble * 0.3;
      pts.push(`${cx + r * Math.cos(a)}px ${cy + r * Math.sin(a)}px`);
    }
    this.canvas.style.clipPath = `polygon(${pts.join(',')})`;
  }

  /* ─── Tile destruction ─── */

  getTotalTiles() {
    return this.originalPositions ? this.originalPositions.length / 9 : 5120;
  }

  getDestroyedCount() {
    return this.getTotalTiles() - this.intactIndices.length;
  }

  destroyRandomTile() {
    if (this.intactIndices.length === 0) return;
    const arrIdx = Math.floor(Math.random() * this.intactIndices.length);
    const triIdx = this.intactIndices[arrIdx];
    this.intactIndices.splice(arrIdx, 1);

    const pos = this.sphereGeo.attributes.position;
    const baseIdx = triIdx * 3;
    const verts = [];
    for (let j = 0; j < 3; j++) {
      verts.push(new THREE.Vector3(
        this.originalPositions[(baseIdx + j) * 3],
        this.originalPositions[(baseIdx + j) * 3 + 1],
        this.originalPositions[(baseIdx + j) * 3 + 2],
      ));
    }

    // Apply sphere's current world transform so the falling tile
    // spawns at the triangle's actual visual position (not the
    // original unrotated position, which can be behind the camera).
    this.sphereMesh.updateMatrixWorld();
    const worldMat = this.sphereMesh.matrixWorld;
    for (let j = 0; j < 3; j++) {
      verts[j].applyMatrix4(worldMat);
    }

    const center = new THREE.Vector3().add(verts[0]).add(verts[1]).add(verts[2]).divideScalar(3);
    const triGeo = new THREE.BufferGeometry();
    const tv = new Float32Array(9);
    for (let j = 0; j < 3; j++) {
      const v = verts[j].clone().sub(center);
      tv[j * 3] = v.x; tv[j * 3 + 1] = v.y; tv[j * 3 + 2] = v.z;
    }
    triGeo.setAttribute('position', new THREE.BufferAttribute(tv, 3));
    triGeo.computeVertexNormals();

    const mesh = new THREE.Mesh(triGeo, new THREE.MeshPhongMaterial({
      color: 0xffffff, emissive: 0x888888, flatShading: true, side: THREE.DoubleSide, shininess: 5,
    }));
    mesh.position.copy(center);
    this.scene.add(mesh);

    const dir = center.clone().normalize().multiplyScalar(-1);
    this.fallingTiles.push({
      mesh,
      velocity: dir.multiplyScalar(8 + Math.random() * 8),
      angularVel: new THREE.Vector3(
        (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4,
      ),
      life: 3,
    });

    for (let j = 0; j < 3; j++) pos.setXYZ(baseIdx + j, 0, 0, 0);
    pos.needsUpdate = true;
  }

  /* ─── Guitar Hero 3D ─── */

  setupGuitarHero() {
    this.ghActive = true;
    this.ghFadeIn = 0; // reset fade-in timer

    // Camera is already tilted at init — no transform change needed

    // Catch line — start invisible, will fade in
    const clGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(GH3D.X_MIN - 0.3, GH3D.NOTE_Y, GH3D.CATCH_Z),
      new THREE.Vector3(GH3D.X_MAX + 0.3, GH3D.NOTE_Y, GH3D.CATCH_Z),
    ]);
    this.ghCatchLine = new THREE.Line(clGeo, new THREE.LineBasicMaterial({
      color: 0x444444, transparent: true, opacity: 0,
    }));
    this.ghCatchLine._targetOpacity = 0.6;
    this.scene.add(this.ghCatchLine);

    // Lane lines — gradient fade into the distance (per-vertex alpha)
    // Lines fade from full opacity at CATCH_Z to 0 well before SPAWN_Z
    const laneCount = 11;
    const segCount = 30; // segments per lane for smooth gradient
    const fadeEnd = GH3D.CATCH_Z + (GH3D.SPAWN_Z - GH3D.CATCH_Z) * 0.70; // fade out at 70% depth

    // Custom shader for per-vertex alpha on lines
    const laneShaderMat = new THREE.ShaderMaterial({
      transparent: true,
      uniforms: {
        uColor: { value: new THREE.Color(0x666666) },
        uGlobalOpacity: { value: 0 }, // starts at 0, fades in
      },
      vertexShader: `
        attribute float alpha;
        varying float vAlpha;
        void main() {
          vAlpha = alpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uGlobalOpacity;
        varying float vAlpha;
        void main() {
          gl_FragColor = vec4(uColor, vAlpha * uGlobalOpacity);
        }
      `,
    });

    for (let i = 0; i < laneCount; i++) {
      const x = GH3D.X_MIN + ((GH3D.X_MAX - GH3D.X_MIN) * i) / (laneCount - 1);
      const positions = new Float32Array((segCount + 1) * 3);
      const alphas = new Float32Array(segCount + 1);

      for (let s = 0; s <= segCount; s++) {
        const t = s / segCount;
        const z = GH3D.CATCH_Z + (fadeEnd - GH3D.CATCH_Z) * t;
        positions[s * 3] = x;
        positions[s * 3 + 1] = GH3D.NOTE_Y;
        positions[s * 3 + 2] = z;
        // Quadratic falloff: fully opaque near catch, zero at fadeEnd
        alphas[s] = Math.pow(1 - t, 2);
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1));

      const mat = laneShaderMat.clone();
      const line = new THREE.Line(geo, mat);
      line._targetOpacity = 0.25;
      this.scene.add(line);
      this.ghLaneLines.push(line);
    }

    // Marker
    const mGeo = new THREE.SphereGeometry(GH3D.MARKER_R, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    const mDisc = new THREE.CircleGeometry(GH3D.MARKER_R, 16);
    mDisc.rotateX(Math.PI / 2);
    this.marker = new THREE.Group();
    const mMat = new THREE.MeshPhongMaterial({
      color: 0xcccccc, shininess: 60, specular: 0x444444,
      transparent: true, opacity: 0, // start invisible, will fade in
    });
    this.marker.add(new THREE.Mesh(mGeo, mMat));
    this.marker.add(new THREE.Mesh(mDisc, mMat));
    this.marker.position.set(0, GH3D.NOTE_Y, GH3D.CATCH_Z);
    this.scene.add(this.marker);
  }

  teardownGuitarHero() {
    this.ghActive = false;
    if (this.ghCatchLine) { this.scene.remove(this.ghCatchLine); this.ghCatchLine = null; }
    for (const l of this.ghLaneLines) this.scene.remove(l);
    this.ghLaneLines = [];
    if (this.marker) { this.scene.remove(this.marker); this.marker = null; }
  }

  createNoteMesh() {
    const g = new THREE.Group();
    const mat = new THREE.MeshPhongMaterial({
      color: 0x7088b0,
      shininess: 80,
      specular: 0x555555,
      transparent: true,
      opacity: 0,
    });
    g.add(new THREE.Mesh(this.noteGeo, mat));
    g.add(new THREE.Mesh(this.noteDiscGeo, mat));
    this.scene.add(g);
    return g;
  }

  removeNoteMesh(mesh) {
    this.scene.remove(mesh);
    mesh.children.forEach((c) => { c.material.dispose(); });
  }

  setNoteOpacity(mesh, opacity) {
    mesh.children.forEach((c) => {
      c.material.opacity = opacity;
    });
  }

  setNoteMissed(mesh) {
    mesh.children.forEach((c) => {
      c.material.color.set(0xff4444);
      c.material.emissive.set(0x660000);
      c.material.shininess = 30;
    });
  }

  setNoteHit(mesh) {
    mesh.children.forEach((c) => {
      c.material.color.set(0x44ff66);
      c.material.emissive.set(0x006600);
      c.material.shininess = 30;
    });
  }

  setMarkerX(worldX) {
    if (this.marker) this.marker.position.x = worldX;
  }

  /* ─── Render ─── */

  render(dt) {
    // Always rotate the sphere mesh directly (independent of camera)
    this.sphereRotationY += dt * 0.08;
    this.sphereRotationX += dt * 0.02;
    if (this.sphereMesh) {
      this.sphereMesh.rotation.set(
        Math.sin(this.sphereRotationX) * 0.15,
        this.sphereRotationY,
        0
      );
    }

    // Guitar hero element fade-in
    if (this.ghActive && this.ghFadeIn < 1) {
      this.ghFadeIn = Math.min(1, this.ghFadeIn + dt / this.ghFadeDuration);
      const t = this.ghFadeIn;
      // Ease-out for a smooth appearance
      const eased = 1 - Math.pow(1 - t, 2);

      if (this.ghCatchLine) {
        this.ghCatchLine.material.opacity = eased * this.ghCatchLine._targetOpacity;
      }
      for (const lane of this.ghLaneLines) {
        lane.material.uniforms.uGlobalOpacity.value = eased * lane._targetOpacity;
      }
      if (this.marker) {
        this.marker.children.forEach((c) => {
          c.material.opacity = eased;
        });
      }
    }

    for (let i = this.fallingTiles.length - 1; i >= 0; i--) {
      const t = this.fallingTiles[i];
      t.life -= dt;
      t.velocity.y -= 12 * dt;
      t.mesh.position.addScaledVector(t.velocity, dt);
      t.mesh.rotation.x += t.angularVel.x * dt;
      t.mesh.rotation.y += t.angularVel.y * dt;
      t.mesh.rotation.z += t.angularVel.z * dt;
      if (t.life < 1) { t.mesh.material.opacity = t.life / 2; t.mesh.material.transparent = true; }
      if (t.life <= 0) {
        this.scene.remove(t.mesh);
        t.mesh.geometry.dispose();
        t.mesh.material.dispose();
        this.fallingTiles.splice(i, 1);
      }
    }

    this.renderer.render(this.scene, this.camera);
  }

  _onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  dispose() {
    this.renderer.dispose();
    this.sphereGeo.dispose();
    this.material.dispose();
    for (const t of this.fallingTiles) { t.mesh.geometry.dispose(); t.mesh.material.dispose(); }
  }
}
