/**
 * The slice of a Discord channel the command layer actually uses.
 *
 * These calls were written as
 *
 *     (message.channel as unknown as { send: (m: Record<string, unknown>) => Promise<unknown> }).send(...)
 *
 * which is production code contorted so a test could hand in a plain object
 * instead of a real channel. That is the coupling AGENTS.md section 11 warns
 * about: the double and the code agree, so the test cannot fail, and in
 * exchange the real type is erased at every call site.
 *
 * `replyChannel` is the one place that erasure is allowed, and it verifies the
 * method exists before handing the value back. Every caller downstream gets a
 * real type, so a typo in a payload key is a compile error rather than a
 * runtime surprise - which the inline casts made impossible to catch.
 */

/** The minimum needed to post a message. */
export interface ReplyChannel {
  send(payload: Record<string, unknown>): Promise<unknown>;
}

/** A reply channel that can also show a typing indicator. */
export interface TypingChannel extends ReplyChannel {
  sendTyping(): Promise<void>;
}

/** A sent message the command layer may need to edit in place. */
export interface EditableMessage {
  edit(payload: Record<string, unknown>): Promise<unknown>;
}

/** A reply channel that can fetch a previously sent message. */
export interface FetchableChannel extends ReplyChannel {
  messages: { fetch(id: string): Promise<EditableMessage> };
}

const has = (value: unknown, method: string): boolean =>
  typeof (value as Record<string, unknown> | null)?.[method] === 'function';

/**
 * Narrow an unknown channel to a {@link ReplyChannel}.
 *
 * Throws rather than returning null: every caller here is on a path where
 * replying is the entire point of the function, so a channel that cannot
 * receive a message is a bug, not a case to silently skip. The command layer
 * already catches and reports handler failures.
 */
export const replyChannel = (channel: unknown): ReplyChannel => {
  if (!has(channel, 'send')) {
    throw new TypeError('channel does not support send()');
  }
  return channel as ReplyChannel;
};

/** As {@link replyChannel}, but the caller also needs typing. */
export const typingChannel = (channel: unknown): TypingChannel => {
  if (!has(channel, 'send') || !has(channel, 'sendTyping')) {
    throw new TypeError('channel does not support send()/sendTyping()');
  }
  return channel as TypingChannel;
};

/** As {@link replyChannel}, but the caller also needs to fetch a message. */
export const fetchableChannel = (channel: unknown): FetchableChannel => {
  // `messages` is an object, not a method, so it needs its own check - reusing
  // `has` here reported every real channel as unusable.
  const messages = (channel as { messages?: { fetch?: unknown } } | null)?.messages;
  if (!has(channel, 'send') || typeof messages?.fetch !== 'function') {
    throw new TypeError('channel does not support send()/messages.fetch()');
  }
  return channel as FetchableChannel;
};
