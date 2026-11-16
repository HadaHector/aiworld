// Labels over a dungeon part's spots in the workbench (DUNGEONS.md, *What fills it*): where its
// creatures stand (`spawns`), its boss, its chest, its quest objects - a post up from the floor and
// a name on a card that always faces the camera, unlit so it reads in the dark.
import { Color3, DynamicTexture, Mesh, MeshBuilder, StandardMaterial, type Scene } from "@babylonjs/core";

export interface SpotLabel {
  at: [number, number, number];
  text: string;
  color: [number, number, number];
}

/** The colour of each kind of spot, and what its label says. */
export const SPOT_KINDS: Record<string, { text: string; color: [number, number, number] }> = {
  spawns: { text: "Spawn", color: [0.9, 0.25, 0.2] },
  boss: { text: "Boss", color: [0.7, 0.3, 0.9] },
  chest: { text: "Chest", color: [0.95, 0.75, 0.2] },
  quest: { text: "Quest", color: [0.3, 0.75, 0.95] },
};

/** How high over its spot a label floats, and how big its card is. */
const RAISE = 2.6;
const CARD: [number, number] = [2.4, 0.8];

/** Puts the labels into a scene; disposing the returned mesh takes them all away. */
export function addSpotLabels(scene: Scene, labels: readonly SpotLabel[]): Mesh {
  const root = new Mesh("spotLabels", scene);
  labels.forEach((label, i) => {
    const [x, y, z] = label.at;
    const color = new Color3(...label.color);
    // The post, from the floor up to the card.
    const post = MeshBuilder.CreateCylinder(`spotPost:${i}`, { height: RAISE, diameter: 0.08, tessellation: 6 }, scene);
    post.position.set(x, y + RAISE / 2, z);
    const postMaterial = new StandardMaterial(`spotPostMat:${i}`, scene);
    postMaterial.emissiveColor = color;
    postMaterial.disableLighting = true;
    post.material = postMaterial;
    post.parent = root;
    // A disc on the floor where it stands.
    const disc = MeshBuilder.CreateDisc(`spotDisc:${i}`, { radius: 0.5, tessellation: 16 }, scene);
    disc.rotation.x = Math.PI / 2;
    disc.position.set(x, y + 0.03, z);
    disc.material = postMaterial;
    disc.parent = root;
    // The card: its text on a texture, facing the camera.
    const texture = new DynamicTexture(`spotText:${i}`, { width: 384, height: 128 }, scene, true);
    const ctx = texture.getContext() as CanvasRenderingContext2D;
    ctx.fillStyle = `rgba(${label.color.map((c) => Math.round(c * 255 * 0.45)).join(",")}, 0.9)`;
    ctx.fillRect(0, 0, 384, 128);
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 64px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label.text, 192, 66);
    texture.update();
    const card = MeshBuilder.CreatePlane(`spotCard:${i}`, { width: CARD[0], height: CARD[1] }, scene);
    card.billboardMode = Mesh.BILLBOARDMODE_ALL;
    card.position.set(x, y + RAISE + CARD[1] / 2, z);
    const cardMaterial = new StandardMaterial(`spotCardMat:${i}`, scene);
    cardMaterial.diffuseTexture = texture;
    cardMaterial.emissiveTexture = texture;
    cardMaterial.disableLighting = true;
    cardMaterial.backFaceCulling = false;
    card.material = cardMaterial;
    card.parent = root;
  });
  return root;
}
