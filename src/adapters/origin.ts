import path from "node:path";
import type { AdapterLoadOptions, CanonicalSession, SessionClassification, SessionReference, SourceFingerprint } from "../common/types.js";
import type { SessionAdapter } from "./adapter.js";

export class OriginAdapter implements SessionAdapter {
  readonly source;
  readonly discoveryRoot: string;
  constructor(
    private readonly adapter: SessionAdapter,
    readonly origin: string,
    private readonly physicalRoot: string,
    private readonly logicalRoot: string,
    private readonly stableRoot = physicalRoot,
  ) { this.source = adapter.source; this.discoveryRoot = physicalRoot; }

  private translate(locator: string, from: string, to: string): string {
    const suffix = locator.slice(from.length);
    if (locator !== from && !suffix.startsWith(path.sep) && !suffix.startsWith("#")) throw new Error(`Locator is outside ${from}`);
    return `${to}${suffix}`;
  }

  private physical(reference: SessionReference): SessionReference {
    const locator = reference.locator.startsWith(this.stableRoot) && this.stableRoot !== this.physicalRoot
      ? this.translate(reference.locator, this.stableRoot, this.physicalRoot)
      : reference.locator.startsWith(this.logicalRoot) && !reference.locator.startsWith(this.physicalRoot)
        ? this.translate(reference.locator, this.logicalRoot, this.physicalRoot) : reference.locator;
    return { ...reference, locator, sourcePath: reference.sourcePath && reference.sourcePath.startsWith(this.logicalRoot) && !reference.sourcePath.startsWith(this.physicalRoot)
      ? this.translate(reference.sourcePath, this.logicalRoot, this.physicalRoot) : reference.sourcePath };
  }

  private logical(locator: string): string { return this.translate(locator, this.physicalRoot, this.logicalRoot); }

  async *discover(): AsyncIterable<SessionReference> {
    for await (const reference of this.adapter.discover()) {
      yield { ...reference, origin: this.origin, locator: this.translate(reference.locator, this.physicalRoot, this.stableRoot), logicalLocator: this.logical(reference.locator), metadata: { ...reference.metadata, source_path: this.logical(reference.metadata.source_path) } };
    }
  }

  fingerprint(reference: SessionReference): Promise<SourceFingerprint> {
    return this.adapter.fingerprint(this.physical(reference)).then((fingerprint) => ({ ...fingerprint, stableLocator: this.logical(fingerprint.stableLocator) }));
  }

  classify(reference: SessionReference): Promise<SessionClassification> {
    return this.adapter.classify(this.physical(reference));
  }

  async load(reference: SessionReference, options: AdapterLoadOptions): Promise<CanonicalSession> {
    const session = await this.adapter.load(this.physical(reference), options);
    session.metadata.source_path = this.logical(session.metadata.source_path);
    session.sourceLocator = reference.locator;
    return session;
  }
}
