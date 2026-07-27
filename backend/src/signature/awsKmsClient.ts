import {KmsSigningError, type KmsClient} from "./kmsSigner.js";

/**
 * `KmsClient` backed by AWS KMS.
 *
 * The `@aws-sdk/client-kms` dependency is loaded with a dynamic import, not a static one, so the
 * backend builds and runs without it — a deployment using `LocalSponsorshipSigner` should not have
 * to install the AWS SDK. Operators who configure a KMS key add the package (it is an
 * optionalDependency). The import failure message says exactly that.
 *
 * The KMS key must be an asymmetric `ECC_SECG_P256K1` key with usage `SIGN_VERIFY`. The digest is
 * signed with `MessageType: DIGEST` and `SigningAlgorithm: ECDSA_SHA_256` — KMS signs the 32 bytes
 * as-is rather than hashing them again, which is required because the paymaster recovers against the
 * EIP-712 digest directly.
 */
export class AwsKmsClient implements KmsClient {
  readonly #keyId: string;
  readonly #region: string | undefined;
  // The KMS SDK client, lazily constructed on first use.
  #client: KmsSdkClient | undefined;

  constructor(options: {keyId: string; region?: string | undefined}) {
    this.#keyId = options.keyId;
    this.#region = options.region;
  }

  async getPublicKeyDer(): Promise<Uint8Array> {
    const {GetPublicKeyCommand} = await loadSdk();
    const client = await this.#getClient();
    const response = await client.send(new GetPublicKeyCommand({KeyId: this.#keyId}));
    if (response.PublicKey === undefined) throw new KmsSigningError("KMS GetPublicKey returned no key");
    return toUint8Array(response.PublicKey);
  }

  async sign(digest: Uint8Array): Promise<Uint8Array> {
    const {SignCommand} = await loadSdk();
    const client = await this.#getClient();
    const response = await client.send(
      new SignCommand({
        KeyId: this.#keyId,
        Message: digest,
        MessageType: "DIGEST",
        SigningAlgorithm: "ECDSA_SHA_256",
      }),
    );
    if (response.Signature === undefined) throw new KmsSigningError("KMS Sign returned no signature");
    return toUint8Array(response.Signature);
  }

  async #getClient(): Promise<KmsSdkClient> {
    if (this.#client === undefined) {
      const {KMSClient} = await loadSdk();
      this.#client = new KMSClient(this.#region === undefined ? {} : {region: this.#region});
    }
    return this.#client;
  }
}

/** The slice of `@aws-sdk/client-kms` we use, typed structurally to avoid a compile-time dependency. */
interface KmsSdkModule {
  KMSClient: new (config: {region?: string}) => KmsSdkClient;
  GetPublicKeyCommand: new (input: {KeyId: string}) => unknown;
  SignCommand: new (input: {
    KeyId: string;
    Message: Uint8Array;
    MessageType: "DIGEST";
    SigningAlgorithm: "ECDSA_SHA_256";
  }) => unknown;
}

interface KmsSdkClient {
  send(command: unknown): Promise<{PublicKey?: Uint8Array; Signature?: Uint8Array}>;
}

async function loadSdk(): Promise<KmsSdkModule> {
  try {
    // Bypasses static resolution so tsc/build do not require the package to be present.
    return (await import(/* @vite-ignore */ "@aws-sdk/client-kms" as string)) as unknown as KmsSdkModule;
  } catch {
    throw new KmsSigningError(
      "KMS signing requires the @aws-sdk/client-kms package. Install it (npm i @aws-sdk/client-kms) " +
        "to use SPONSORSHIP_SIGNER_KMS_KEY_ID.",
    );
  }
}

/** KMS SDK returns bytes as Uint8Array already, but normalise defensively. */
function toUint8Array(value: Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}
