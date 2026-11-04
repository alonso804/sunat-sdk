import { SignedXml } from 'xml-crypto';
import { SIGNATURE_ID } from '../xml';
import type { SigningKey } from './certificate';

/**
 * Algoritmos de firma del XML. Es un objeto `as const` y a la vez un tipo con el mismo nombre:
 * `SignatureAlgorithm.sha1` es el valor y `SignatureAlgorithm` la unión de todos.
 */
export const SignatureAlgorithm = {
  /** RSA-SHA1 / SHA1: el que documenta el manual de SUNAT (por defecto). Las guías se aceptan así en producción. */
  sha1: 'sha1',
  /** RSA-SHA256 / SHA256: SUNAT beta lo acepta; confirma qué exige producción antes de usarlo. */
  sha256: 'sha256',
} as const;
export type SignatureAlgorithm = (typeof SignatureAlgorithm)[keyof typeof SignatureAlgorithm];

const ALGORITHMS = {
  // El manual del programador de SUNAT documenta RSA-SHA1 / SHA1. SHA-256 queda disponible
  // para cuando SUNAT lo exija; se debe confirmar contra el ambiente que corresponda.
  sha1: {
    signature: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
    digest: 'http://www.w3.org/2000/09/xmldsig#sha1',
  },
  sha256: {
    signature: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    digest: 'http://www.w3.org/2001/04/xmlenc#sha256',
  },
} as const;

const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';

/**
 * Firma el documento completo (XMLDSig enveloped) y coloca la firma dentro de
 * `ext:UBLExtensions/ext:UBLExtension/ext:ExtensionContent`, como exige SUNAT.
 * Después de firmar no se puede modificar el XML.
 */
export function signUblXml(xml: string, key: SigningKey, algorithm: SignatureAlgorithm = SignatureAlgorithm.sha1): string {
  const algo = ALGORITHMS[algorithm];
  const sig = new SignedXml({
    privateKey: key.privateKeyPem,
    publicCert: key.certificatePem,
    signatureAlgorithm: algo.signature,
    canonicalizationAlgorithm: C14N,
  });
  sig.addReference({
    xpath: '/*',
    transforms: [ENVELOPED],
    digestAlgorithm: algo.digest,
    isEmptyUri: true,
  });
  sig.computeSignature(xml, {
    prefix: 'ds',
    attrs: { Id: SIGNATURE_ID },
    location: { reference: "//*[local-name(.)='ExtensionContent']", action: 'append' },
  });

  const signed = sig.getSignedXml();
  return signed.startsWith('<?xml') ? signed : `<?xml version="1.0" encoding="UTF-8"?>${signed}`;
}

/** Verifica la firma de un XML ya firmado con el certificado que lleva incrustado. */
export function verifyUblSignature(signedXml: string, certificatePem: string): boolean {
  const verifier = new SignedXml({ publicCert: certificatePem });
  const signatureNode = /<ds:Signature[\s\S]*<\/ds:Signature>/.exec(signedXml)?.[0];
  if (!signatureNode) return false;
  verifier.loadSignature(signatureNode);
  return verifier.checkSignature(signedXml);
}

/** DigestValue (hash del documento) que SUNAT exige en la representación impresa / código QR. */
export function extractDigestValue(signedXml: string): string | undefined {
  return /<ds:DigestValue>([^<]+)<\/ds:DigestValue>/.exec(signedXml)?.[1];
}
