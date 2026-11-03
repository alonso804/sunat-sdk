export { SunatClient } from './client';
export type {
  GreCredentials,
  InvoiceStatusQuery,
  InvoiceStatusResult,
  InvoiceSummary,
  PreparedInvoice,
  SendInvoiceResult,
  SunatClientConfig,
} from './client';

export { ENDPOINTS } from './config';
export type { Environment } from './config';

export { DespatchSchema } from './despatch/schema';
export type { Despatch, DespatchInput } from './despatch/schema';
export type { DespatchResult, DespatchSendOptions, DespatchSummary, PreparedDespatch } from './despatch/service';
export { GRE_ENDPOINTS } from './gre/api';
export { downloadDespatchPdf } from './gre/pdf';
export type { DespatchPdf, DespatchPdfOptions } from './gre/pdf';
export { RELATED_DOCUMENT_TYPES, TRANSFER_REASONS } from './catalogs';

export { SunatApiError, SunatError, SunatFaultError, SunatTransportError, SunatValidationError } from './errors';

export { InvoiceSchema, IssuerSchema } from './invoice/schema';
export type {
  Invoice,
  InvoiceInput,
  InvoiceItem,
  InvoicePayment,
  Issuer,
  IssuerInput,
  RelatedDespatch,
} from './invoice/schema';

export type { Cdr } from './cdr';

export { checkCertificate, describeCertificate, signingKeyFromPem, signingKeyFromPfx } from './signing/certificate';
export type { CertificateCheck, CertificateInfo, SigningKey } from './signing/certificate';
export type { SignatureAlgorithm } from './signing/xmldsig';

export { isValidRuc } from './ruc';
