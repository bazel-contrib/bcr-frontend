package intoto

import (
	"crypto/x509"
	"encoding/asn1"
)

// Fulcio "GitHub Actions OIDC" extension OIDs we read.
// Full registry: https://github.com/sigstore/fulcio/blob/main/docs/oid-info.md
var (
	// V1 issuer OID — value is a raw UTF-8 string, not DER-wrapped.
	fulcioOIDIssuerV1 = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 57264, 1, 1}
	// V2 issuer OID — value is a DER-encoded UTF8String wrapping the issuer URL.
	fulcioOIDIssuerV2 = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 57264, 1, 8}
)

// signerFromCert extracts the SAN URI (signer identity) and OIDC issuer URL
// from a Fulcio leaf certificate. Either return value may be empty if the
// corresponding field is absent.
func signerFromCert(cert *x509.Certificate) (identity, issuer string) {
	if len(cert.URIs) > 0 && cert.URIs[0] != nil {
		identity = cert.URIs[0].String()
	}
	for _, ext := range cert.Extensions {
		switch {
		case ext.Id.Equal(fulcioOIDIssuerV1):
			// V1 OID stores raw UTF-8 bytes (no DER wrapper).
			issuer = string(ext.Value)
			return
		case ext.Id.Equal(fulcioOIDIssuerV2):
			var s string
			if _, err := asn1.Unmarshal(ext.Value, &s); err == nil {
				issuer = s
				return
			}
		}
	}
	return
}
