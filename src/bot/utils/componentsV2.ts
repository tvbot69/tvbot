import { ContainerBuilder, MessageFlags } from 'discord.js';

export interface ComponentsV2Payload {
  components: [ContainerBuilder];
  flags: MessageFlags;
  allowedMentions: { parse: string[] };
  files?: Array<{
    attachment: Buffer;
    name: string;
    description?: string;
  }>;
}

/**
 * Encapsulates Discord Components V2 payload construction
 * ensuring consistent flags and typed structure across command and interaction handlers.
 */
export function buildComponentsV2Payload(
  container: ContainerBuilder,
  file?: { buffer: Buffer; name: string; description?: string },
): ComponentsV2Payload {
  const payload: ComponentsV2Payload = {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  };

  if (file?.buffer && file.name) {
    payload.files = [
      {
        attachment: file.buffer,
        name: file.name,
        description: file.description,
      },
    ];
  }

  return payload;
}
