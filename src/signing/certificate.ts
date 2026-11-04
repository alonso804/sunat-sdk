import forge from 'node-forge';
import { SunatError } from '../errors';

/** Par llave privada + certificado, ambos en PEM, listos para firmar. */
export type SigningKey = {
  privateKeyPem: string;
  certificatePem: string;
};

export type CertificateInfo = {
  subject: Record<string, string>;
  issuer: Record<string, string>;
  serialNumber: string;
  notBefore: Date;
  notAfter: Date;
  /** Tamaño de la llave RSA en bits (lo habitual es 2048). */
  keyBits: number;
  /** Algoritmo con que la entidad de certificación firmó este certificado, p. ej. `sha256WithRSAEncryption`. */
  signatureAlgorithm: string;
  /** Huella SHA-256 del certificado, en hexadecimal con dos puntos. */
  fingerprintSha256: string;
};

// node-forge tipa los OID como opcionales; son constantes del estándar PKCS#12.
const OID = {
  pkcs8ShroudedKeyBag: forge.pki.oids.pkcs8ShroudedKeyBag as string,
  keyBag: forge.pki.oids.keyBag as string,
  certBag: forge.pki.oids.certBag as string,
};

/**
 * Arma la llave de firma a partir de la llave privada y el certificado en PEM, si ya los tienes por separado
 * (p. ej. guardados en un gestor de secretos). Si tienes el archivo `.pfx` / `.p12`, usa `signingKeyFromPfx`.
 *
 * @param privateKeyPem - Llave privada RSA en PEM (`-----BEGIN RSA PRIVATE KEY-----` o `-----BEGIN PRIVATE KEY-----`).
 * @param certificatePem - Certificado digital en PEM (`-----BEGIN CERTIFICATE-----`).
 * @returns La llave para `SunatClientConfig.signingKey`. No valida el contenido: un PEM incorrecto falla al firmar.
 */
export function signingKeyFromPem(privateKeyPem: string, certificatePem: string): SigningKey {
  return { privateKeyPem, certificatePem };
}

/**
 * Extrae llave privada y certificado de un archivo PKCS#12 (.pfx / .p12), que es el formato en que SUNAT entrega el
 * Certificado Digital Tributario. Si el archivo trae toda la cadena, elige el certificado que corresponde a la llave.
 *
 * @param pfx - Contenido del archivo (`readFileSync('certificado.pfx')`).
 * @param passphrase - Contraseña de la llave privada (la que se definió al descargar el certificado).
 * @returns La llave para `SunatClientConfig.signingKey`.
 * @throws {SunatError} Si la contraseña es incorrecta, el archivo está dañado o no trae una llave RSA con su
 *   certificado.
 *
 * @example
 * ```ts
 * const signingKey = signingKeyFromPfx(readFileSync('certificado.pfx'), process.env.CERT_PASSWORD!);
 * ```
 */
export function signingKeyFromPfx(pfx: Uint8Array, passphrase: string): SigningKey {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    const der = forge.util.createBuffer(Buffer.from(pfx).toString('binary'));
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), passphrase);
  } catch (cause) {
    throw new SunatError('No se pudo abrir el archivo PFX: verifica la contraseña y que el archivo no esté dañado.', {
      cause,
    });
  }

  const bagsOf = (oid: string): forge.pkcs12.Bag[] => p12.getBags({ bagType: oid })[oid] ?? [];

  const keyBags = [...bagsOf(OID.pkcs8ShroudedKeyBag), ...bagsOf(OID.keyBag)];
  const privateKey = keyBags
    .map((bag) => bag.key as unknown)
    .find(
      (key): key is forge.pki.rsa.PrivateKey => typeof key === 'object' && key !== null && 'n' in key && 'd' in key,
    );
  if (!privateKey) throw new SunatError('El PFX no contiene una llave privada RSA.');

  const certificates = bagsOf(OID.certBag)
    .map((bag) => bag.cert)
    .filter((cert): cert is forge.pki.Certificate => Boolean(cert));

  // El PFX puede traer toda la cadena: se elige el certificado que corresponde a la llave privada.
  const modulus = privateKey.n.toString(16);
  const own = certificates.find((cert) => (cert.publicKey as forge.pki.rsa.PublicKey).n.toString(16) === modulus);
  if (!own) throw new SunatError('El PFX no contiene un certificado que corresponda a la llave privada.');

  return {
    privateKeyPem: forge.pki.privateKeyToPem(privateKey),
    certificatePem: forge.pki.certificateToPem(own),
  };
}

function attributes(list: forge.pki.CertificateField[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const attr of list) {
    const key = (attr.shortName ?? attr.name) as string | undefined;
    if (key) out[key] = decodeAttribute(attr);
  }
  return out;
}

/**
 * node-forge entrega los textos UTF-8 del certificado como bytes (cada byte, un carácter), de modo que
 * "Identificación" aparece como "IdentificaciÃ³n". Se decodifican como UTF-8 solo los campos UTF8String.
 */
function decodeAttribute(attr: forge.pki.CertificateField): string {
  const value = String(attr.value);
  const isUtf8 = (attr as { valueTagClass?: number }).valueTagClass === forge.asn1.Type.UTF8;
  return isUtf8 ? Buffer.from(value, 'latin1').toString('utf8') : value;
}

/**
 * Lee los datos del certificado (titular, emisor, vigencia, tamaño de llave, huella) para mostrarlos o revisarlos.
 * No contacta a nadie.
 *
 * @param certificatePem - Certificado en PEM; por ejemplo, `signingKey.certificatePem`.
 * @returns Titular y emisor (por atributo, p. ej. `CN`), número de serie, vigencia, bits de la llave, algoritmo y
 *   huella SHA-256.
 * @throws {Error} Si el texto no es un certificado PEM válido.
 */
export function describeCertificate(certificatePem: string): CertificateInfo {
  const cert = forge.pki.certificateFromPem(certificatePem);
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const fingerprint = forge.md.sha256.create().update(der).digest().toHex().toUpperCase();
  return {
    subject: attributes(cert.subject.attributes),
    issuer: attributes(cert.issuer.attributes),
    serialNumber: cert.serialNumber,
    notBefore: cert.validity.notBefore,
    notAfter: cert.validity.notAfter,
    keyBits: (cert.publicKey as forge.pki.rsa.PublicKey).n.bitLength(),
    signatureAlgorithm: String(forge.pki.oids[cert.siginfo.algorithmOid] ?? cert.siginfo.algorithmOid),
    fingerprintSha256: (fingerprint.match(/.{2}/g) ?? []).join(':'),
  };
}

export type CertificateCheck = {
  /** `false` si hay un problema que impide usar el certificado (vencido o aún no vigente). */
  ok: boolean;
  problems: string[];
  warnings: string[];
  /** Días que faltan para el vencimiento (negativo si ya venció). */
  daysRemaining: number;
};

const DAY_MS = 86_400_000;
const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * Revisa si el certificado sirve para firmar: vigencia (avisa desde 60 días antes del vencimiento), tamaño de llave
 * y, si indicas el RUC, que aparezca en el titular.
 *
 * @param info - Resultado de `describeCertificate`.
 * @param options - `ruc` del emisor para comprobar el titular; `now` para evaluar en otra fecha.
 * @returns `ok: false` con `problems` si está vencido o aún no es válido; `warnings` para lo que conviene revisar;
 *   y los días que faltan para el vencimiento.
 *
 * @example
 * ```ts
 * const check = checkCertificate(describeCertificate(signingKey.certificatePem), { ruc: '20000000001' });
 * if (!check.ok) throw new Error(check.problems.join(' '));
 * ```
 */
export function checkCertificate(info: CertificateInfo, options: { ruc?: string; now?: Date } = {}): CertificateCheck {
  const now = options.now ?? new Date();
  const problems: string[] = [];
  const warnings: string[] = [];
  const daysRemaining = Math.floor((info.notAfter.getTime() - now.getTime()) / DAY_MS);

  if (now < info.notBefore)
    problems.push(`El certificado aún no es válido (vigente desde ${isoDate(info.notBefore)}).`);
  if (now > info.notAfter) {
    problems.push(`El certificado venció el ${isoDate(info.notAfter)}.`);
  } else if (daysRemaining <= 60) {
    warnings.push(
      `El certificado vence en ${daysRemaining} días (${isoDate(info.notAfter)}). Solicita uno nuevo con tiempo: el certificado gratuito tiene un límite de 2 por contribuyente.`,
    );
  }
  if (info.keyBits < 2048) warnings.push(`La llave es de ${info.keyBits} bits; lo habitual es 2048.`);
  const ruc = options.ruc;
  if (ruc && !Object.values(info.subject).some((value) => value.includes(ruc))) {
    warnings.push(`No encontré el RUC ${ruc} en el titular del certificado; confirma que corresponde al emisor.`);
  }
  return { ok: problems.length === 0, problems, warnings, daysRemaining };
}
