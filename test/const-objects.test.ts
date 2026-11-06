import { describe, expect, it } from 'vitest';
import {
  Currency,
  DespatchStatus,
  Environment,
  PaymentType,
  SendInvoiceStatus,
  SignatureAlgorithm,
  SunatClient,
  SunatFaultError,
  SunatFaultKind,
  TransportMode,
} from '../src';
import { RucConsultStatus } from '../src/ruc-consult';
import { sampleDespatch, sampleInvoice, TEST_ISSUER, testCertificate } from './helpers';

describe('estados `as const` (objeto y tipo con el mismo nombre)', () => {
  it('conservan los textos de siempre: comparar con el string sigue funcionando', () => {
    expect(SendInvoiceStatus).toEqual({
      accepted: 'accepted',
      acceptedWithObservations: 'accepted_with_observations',
      rejected: 'rejected',
    });
    expect(DespatchStatus).toEqual({
      accepted: 'accepted',
      acceptedWithObservations: 'accepted_with_observations',
      rejected: 'rejected',
      pending: 'pending',
    });
    expect(SunatFaultKind).toEqual({ exception: 'exception', rejected: 'rejected', unknown: 'unknown' });
    expect(RucConsultStatus).toEqual({ found: 'found', notFound: 'not_found' });
  });

  it('SunatFaultError.kind devuelve valores de SunatFaultKind', () => {
    expect(new SunatFaultError('0111', 'sin perfil').kind).toBe(SunatFaultKind.exception);
    expect(new SunatFaultError('2335', 'alterado').kind).toBe(SunatFaultKind.rejected);
    expect(new SunatFaultError('soap-env:Server', 'otro').kind).toBe(SunatFaultKind.unknown);
  });

  it('el nombre sirve como tipo: solo acepta los valores del objeto', () => {
    const send: SendInvoiceStatus = SendInvoiceStatus.acceptedWithObservations;
    const despatch: DespatchStatus = 'pending'; // el texto también vale
    const kind: SunatFaultKind = SunatFaultKind.rejected;
    const ruc: RucConsultStatus = RucConsultStatus.notFound;
    // @ts-expect-error 'pending' no es un estado de factura
    const invalid: SendInvoiceStatus = 'pending';
    expect([send, despatch, kind, ruc, invalid]).toEqual([
      'accepted_with_observations',
      'pending',
      'rejected',
      'not_found',
      'pending',
    ]);
  });
});

describe('opciones `as const` (objeto y tipo con el mismo nombre)', () => {
  it('conservan los textos de siempre', () => {
    expect(Environment).toEqual({ beta: 'beta', homologation: 'homologation', production: 'production' });
    expect(SignatureAlgorithm).toEqual({ sha1: 'sha1', sha256: 'sha256' });
    expect(Currency).toEqual({ PEN: 'PEN', USD: 'USD' });
    expect(PaymentType).toEqual({ cash: 'cash', credit: 'credit' });
    expect(TransportMode).toEqual({ public: 'public', private: 'private' });
  });

  it('se pueden usar en la configuración y en los datos de entrada', () => {
    const client = new SunatClient({
      environment: Environment.beta,
      issuer: TEST_ISSUER,
      sol: { user: 'MODDATOS', password: 'MODDATOS' },
      signingKey: testCertificate().key,
      signatureAlgorithm: SignatureAlgorithm.sha256,
    });
    const invoice = client.prepareInvoice(
      sampleInvoice({
        currency: Currency.USD,
        payment: { type: PaymentType.credit, installments: [{ dueDate: '2026-12-31' }] },
      }),
    );
    expect(invoice.summary.currency).toBe(Currency.USD);
    expect(invoice.summary.payment.type).toBe(PaymentType.credit);
    expect(invoice.signedXml).toContain('http://www.w3.org/2001/04/xmldsig-more#rsa-sha256');

    const despatch = client.prepareDespatch(sampleDespatch({ transportMode: TransportMode.private }));
    expect(despatch.summary.transportMode).toBe(TransportMode.private);
  });

  it('el nombre sirve como tipo y los schemas rechazan valores fuera del objeto', () => {
    const env: Environment = 'production'; // el texto también vale
    const currency: Currency = Currency.PEN;
    // @ts-expect-error 'EUR' no es una moneda admitida
    const invalid: Currency = 'EUR';
    expect([env, currency, invalid]).toEqual(['production', 'PEN', 'EUR']);

    const client = new SunatClient({
      environment: Environment.beta,
      issuer: TEST_ISSUER,
      sol: { user: 'U', password: 'P' },
      signingKey: testCertificate().key,
    });
    // @ts-expect-error 'EUR' no es una moneda admitida
    expect(() => client.prepareInvoice(sampleInvoice({ currency: 'EUR' }))).toThrow(/currency/);
  });
});
