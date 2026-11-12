import type {GLTF, GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';

/** Lossless smaller transfer, with the original asset as a compatibility fallback. */
export async function loadPassAsset(loader: Pick<GLTFLoader, 'parseAsync' | 'loadAsync'>): Promise<GLTF> {
  const url = '/assets/touge/mountain_pass.glb';
  if (typeof DecompressionStream !== 'undefined') {
    try {
      const response = await fetch(`${url}.gz`);
      if (!response.ok || !response.body) throw Error('Compressed pass unavailable');
      // Fetch decodes HTTP Content-Encoding automatically (including Vite's .gz serving).
      const stream = response.headers.get('Content-Encoding')?.includes('gzip')
        ? response.body
        : response.body.pipeThrough(new DecompressionStream('gzip'));
      return await loader.parseAsync(await new Response(stream).arrayBuffer(), '/assets/touge/');
    } catch {
      // Old caches, unsupported streams or a failed transfer can use the raw file.
    }
  }
  return loader.loadAsync(url);
}
