let providerMounted = false;

export function setAdMeshProviderMounted(mounted: boolean): void {
  providerMounted = mounted;
}

export function isAdMeshProviderMounted(): boolean {
  return providerMounted;
}