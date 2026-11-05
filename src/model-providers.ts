import type { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';

export type InheritedModelRegistry = Pick<ModelRegistry,
  'getRegisteredProviderConfig' | 'getRegisteredNativeProvider' | 'getRegisteredProviderIds'>;

/** Copy only the selected provider's trusted public definitions. Never persist them. */
export function seedInheritedProvider(runtime: ModelRuntime, inherited: InheritedModelRegistry | undefined, provider: string): boolean {
  if (!inherited || !inherited.getRegisteredProviderIds().includes(provider)) return false;
  const native = inherited.getRegisteredNativeProvider(provider);
  const config = inherited.getRegisteredProviderConfig(provider);
  if (native) {
    if (typeof runtime.registerNativeProvider !== 'function') throw new Error('Child runtime cannot register the inherited native provider');
    runtime.registerNativeProvider(native);
    return true;
  }
  if (config) {
    if (typeof runtime.registerProvider !== 'function') throw new Error('Child runtime cannot register the inherited provider');
    runtime.registerProvider(provider, config);
    return true;
  }
  return false;
}
