package router

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

func TestAssistantLicenseSignatureAndCanonicalPayload(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	payload := assistantLicensePayload{
		Version: 1, LicenseID: "license-1", UserID: 42,
		InstallationID: "123e4567-e89b-12d3-a456-426614174000",
		IssuedAt: 100, ExpiresAt: 200,
	}
	signature := ed25519.Sign(privateKey, assistantLicenseBytes(payload))
	if !ed25519.Verify(publicKey, assistantLicenseBytes(payload), signature) {
		t.Fatal("license signature did not verify")
	}
	if got := string(assistantLicenseBytes(payload)); got !=
		`{"version":1,"license_id":"license-1","user_id":42,"installation_id":"123e4567-e89b-12d3-a456-426614174000","issued_at":100,"expires_at":200}` {
		t.Fatalf("unexpected canonical payload: %s", got)
	}
}

func TestAssistantLicensePrivateKeyAndRevocationState(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	keyFile := filepath.Join(t.TempDir(), "license.key")
	if err := os.WriteFile(keyFile, []byte(base64.StdEncoding.EncodeToString(der)), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("YISAMA_LICENSE_PRIVATE_KEY_FILE", keyFile)
	loaded, err := assistantLicensePrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	if !privateKey.Equal(loaded) {
		t.Fatal("loaded license key changed")
	}

	stateFile := filepath.Join(t.TempDir(), "license-state.json")
	t.Setenv("YISAMA_LICENSE_STATE_FILE", stateFile)
	state := assistantLicenseState{RevokedInstallations: map[string]string{
		"123e4567-e89b-12d3-a456-426614174000": "test",
	}}
	if err := assistantWriteLicenseState(state); err != nil {
		t.Fatal(err)
	}
	revoked, err := assistantLicenseRevoked("123e4567-e89b-12d3-a456-426614174000")
	if err != nil {
		t.Fatal(err)
	}
	if !revoked {
		t.Fatal("revoked installation was accepted")
	}
	revoked, err = assistantLicenseRevoked("123e4567-e89b-12d3-a456-426614174001")
	if err != nil {
		t.Fatal(err)
	}
	if revoked {
		t.Fatal("unrevoked installation was rejected")
	}
}
