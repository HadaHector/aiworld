import { Effect, Mesh, ShaderMaterial, VertexData, type Scene } from "@babylonjs/core";
import { LIT_SHADING_GLSL, LIT_SHADING_SAMPLERS, LIT_SHADING_UNIFORMS, type LitShading } from "../materials/litShading";
import type { BuildingModel } from "./buildingTypes";

const VERTEX_SHADER = `#version 300 es
precision highp float;

in vec3 position;
in vec3 normal;
in vec4 color;

uniform mat4 world;
uniform mat4 view;
uniform mat4 projection;

out vec3 vNormal;
out vec3 vColor;
out vec3 vWorldPosition;
out vec3 vPositionFromCamera;

void main() {
  vec4 worldPosition = world * vec4(position, 1.0);
  gl_Position = projection * view * worldPosition;
  vNormal = normalize((world * vec4(normal, 0.0)).xyz);
  vColor = color.rgb;
  vWorldPosition = worldPosition.xyz;
  vPositionFromCamera = (view * worldPosition).xyz;
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
${LIT_SHADING_GLSL}

in vec3 vNormal;
in vec3 vColor;
in vec3 vWorldPosition;
in vec3 vPositionFromCamera;

out vec4 outColor;

void main() {
  // Sheets seen from both sides (a roof's eaves from below) face the viewer.
  vec3 n = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
  float diffuse = max(dot(n, normalize(lightDirection)), 0.0) * lightIntensity;
  float shadow = computeShadow(vWorldPosition, n, vPositionFromCamera.z);
  vec3 lit = vColor * diffuse * lightColor * shadow + vColor * ambientColor * ambientIntensity;
  outColor = vec4(applyFog(lit, length(vPositionFromCamera)), 1.0);
}
`;

/** The plain material buildings are drawn with for now: each face its own colour, lit and shadowed
 *  through the shared lighting like everything else. */
export function createBuildingMaterial(scene: Scene, litShading: LitShading): ShaderMaterial {
  Effect.ShadersStore["plainBuildingVertexShader"] = VERTEX_SHADER;
  Effect.ShadersStore["plainBuildingFragmentShader"] = FRAGMENT_SHADER;
  const material = new ShaderMaterial("plainBuilding", scene, "plainBuilding", {
    attributes: ["position", "normal", "color"],
    uniforms: ["world", "view", "projection", ...LIT_SHADING_UNIFORMS],
    samplers: LIT_SHADING_SAMPLERS,
  });
  material.backFaceCulling = false;
  litShading.register(material);
  return material;
}

/** A mesh of one building model, standing at its own origin. */
export function createBuildingMesh(scene: Scene, name: string, model: BuildingModel, material: ShaderMaterial): Mesh {
  const mesh = new Mesh(name, scene);
  const data = new VertexData();
  data.positions = model.positions;
  data.normals = model.normals;
  data.colors = model.colors;
  data.indices = model.indices;
  data.applyToMesh(mesh);
  mesh.material = material;
  mesh.isPickable = false;
  return mesh;
}
