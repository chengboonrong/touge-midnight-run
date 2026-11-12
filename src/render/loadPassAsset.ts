import type {GLTF, GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';

/** Lossless smaller transfer, with the original asset as a compatibility fallback. */
export async function loadPassAsset(loader: Pick<GLTFLoader, 'parseAsync' | 'loadAsync'>): Promise<GLTF> {
  const url = '/assets/touge/mountain_pass.glb';
  if (typeof DecompressionStream !== 'undefined') {
    try {
      const response = await fetch(`${url}.gz`);
      if (!response.ok || !response.body) throw Error('Compressed pass unavailable');
      // Fetch and proxies may already decode gzip and remove its header. Inspect bytes instead.
      const bytes = await response.arrayBuffer();
      const signature = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 2));
      const data = signature[0] === 0x1f && signature[1] === 0x8b
        ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
        : bytes;
      return await loader.parseAsync(data, '/assets/touge/');
    } catch {
      // Old caches, unsupported streams or a failed transfer can use the raw file.
    }
  }
  return loader.loadAsync(url);
}
