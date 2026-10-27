import type { Api } from 'grammy';
import type { BotCommand, CallbackQuery, Message } from 'grammy/types';
import type { BusinessSettings } from '../config/business.js';
import type { Settings } from '../config/settings.js';
import type { Store } from '../storage/database.js';
import type { OwnerOutbox } from '../services/owner-outbox.js';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export interface BusinessExtension {
  commands?: BotCommand[];
  receive?(message: Message): Promise<boolean | void>;
  ownerMessage?(message: Message): boolean | Promise<boolean>;
  callback?(query: CallbackQuery): Promise<boolean>;
  status?(): string;
  tick?(): Promise<void>;
  prune?(): void;
}
export interface ExtensionContext {
  settings: BusinessSettings;
  appConfig: Settings;
  store: Store;
  api: Api;
  notifications: OwnerOutbox;
  aiReady: boolean;
}
/** Trusted operator configuration only; chat content can never select executable code. */
export async function loadBusinessExtensions(
  entry: string,
  context: ExtensionContext,
): Promise<BusinessExtension[]> {
  if (!entry) return [];
  const module = (await import(pathToFileURL(resolve(entry)).href)) as {
    default?: (context: ExtensionContext) => BusinessExtension[] | Promise<BusinessExtension[]>;
  };
  if (typeof module.default !== 'function') throw new Error('INVALID_EXTENSION_FACTORY');
  const extensions = await module.default(context);
  if (!Array.isArray(extensions) || extensions.some((e) => !e || typeof e !== 'object'))
    throw new Error('INVALID_EXTENSIONS');
  return extensions;
}
