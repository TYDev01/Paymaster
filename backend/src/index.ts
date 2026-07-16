export type {PackedUserOperation} from "./domain/userOperation.js";
export {packUint128Pair, UINT48_MAX, ValueOutOfRangeError} from "./domain/userOperation.js";

export {
  decodePaymasterAndData,
  encodePaymasterAndData,
  encodePaymasterAndDataPrefix,
  InvalidPaymasterDataError,
  PAYMASTER_DATA_OFFSET,
  PAYMASTER_POSTOP_GAS_OFFSET,
  PAYMASTER_VALIDATION_GAS_OFFSET,
  SIGNATURE_OFFSET,
  VALID_AFTER_OFFSET,
  VALID_UNTIL_OFFSET,
  type PaymasterAndDataFields,
} from "./signature/paymasterAndData.js";

export {
  paymasterGasLimitsFrom,
  sponsorshipDigest,
  sponsorshipDomain,
  SPONSORSHIP_DOMAIN_NAME,
  SPONSORSHIP_DOMAIN_VERSION,
  SPONSORSHIP_TYPES,
  type SponsorshipDigestParams,
} from "./signature/typedData.js";

export {InvalidSigningKeyError, LocalSponsorshipSigner, type SponsorshipSigner} from "./signature/signer.js";

export {
  InvalidSponsorshipRequestError,
  SignatureEngine,
  type SponsorshipAttestation,
  type SponsorshipRequest,
} from "./signature/signatureEngine.js";
