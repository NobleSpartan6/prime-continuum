export async function retireBrowserEvidence(options) {
  const { metadata, closeEndpoint, processAlive, removeMetadata, removeProfile } = options;
  if (metadata) {
    try {
      await closeEndpoint(metadata);
    } catch (error) {
      if (processAlive(metadata.pid)) throw error;
    }
  }
  await removeMetadata();
  if (removeProfile) await removeProfile();
}
