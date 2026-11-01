package router

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/gin-gonic/gin"
)

const assistantLicenseDuration = 7 * 24 * time.Hour

var (
	assistantLicenseStateMu sync.Mutex
	assistantInstallationID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)
)

type assistantLicensePayload struct {
	Version        int    `json:"version"`
	LicenseID      string `json:"license_id"`
	UserID         int    `json:"user_id"`
	InstallationID string `json:"installation_id"`
	IssuedAt       int64  `json:"issued_at"`
	ExpiresAt      int64  `json:"expires_at"`
}

type assistantLicenseRequest struct {
	InstallationID string `json:"installation_id"`
	Version        string `json:"version"`
	Client         string `json:"client"`
}

type assistantLicenseRevokeRequest struct {
	InstallationID string `json:"installation_id"`
	Reason         string `json:"reason"`
}

type assistantLicenseState struct {
	RevokedInstallations map[string]string `json:"revoked_installations"`
}

func setAssistantLicenseRoutes(api *gin.RouterGroup) {
	license := api.Group("/assistant/license")
	license.Use(middleware.DisableCache(), middleware.UserAuth())
	license.POST("/activate", assistantLicenseActivate)

	admin := api.Group("/assistant/license")
	admin.Use(middleware.DisableCache(), middleware.AdminAuth())
	admin.POST("/revoke", assistantLicenseRevoke)
}

func assistantLicenseActivate(c *gin.Context) {
	var request assistantLicenseRequest
	if err := c.ShouldBindJSON(&request); err != nil ||
		!assistantInstallationID.MatchString(request.InstallationID) ||
		strings.TrimSpace(request.Version) == "" || len(request.Version) > 32 ||
		len(request.Client) > 64 {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "code": "LICENSE_REQUEST_INVALID"})
		return
	}

	revoked, err := assistantLicenseRevoked(request.InstallationID)
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"success": false, "code": "LICENSE_STATE_UNAVAILABLE"})
		return
	}
	if revoked {
		c.JSON(http.StatusForbidden, gin.H{"success": false, "code": "LICENSE_REVOKED"})
		return
	}

	privateKey, err := assistantLicensePrivateKey()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"success": false, "code": "LICENSE_UNAVAILABLE"})
		return
	}
	licenseID, err := assistantRandomID()
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"success": false, "code": "LICENSE_UNAVAILABLE"})
		return
	}
	now := time.Now().Unix()
	payload := assistantLicensePayload{
		Version:        1,
		LicenseID:      licenseID,
		UserID:         c.GetInt("id"),
		InstallationID: request.InstallationID,
		IssuedAt:       now,
		ExpiresAt:      now + int64(assistantLicenseDuration/time.Second),
	}
	signature := ed25519.Sign(privateKey, assistantLicenseBytes(payload))
	common.ApiSuccess(c, gin.H{
		"payload":   payload,
		"signature": base64.RawStdEncoding.EncodeToString(signature),
	})
}

func assistantLicenseRevoke(c *gin.Context) {
	var request assistantLicenseRevokeRequest
	if err := c.ShouldBindJSON(&request); err != nil ||
		!assistantInstallationID.MatchString(request.InstallationID) {
		c.JSON(http.StatusBadRequest, gin.H{"success": false, "code": "LICENSE_REQUEST_INVALID"})
		return
	}
	assistantLicenseStateMu.Lock()
	defer assistantLicenseStateMu.Unlock()
	state, err := assistantReadLicenseState()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "code": "LICENSE_STATE_UNAVAILABLE"})
		return
	}
	if state.RevokedInstallations == nil {
		state.RevokedInstallations = map[string]string{}
	}
	reason := strings.TrimSpace(request.Reason)
	if len(reason) > 200 {
		reason = reason[:200]
	}
	state.RevokedInstallations[request.InstallationID] = reason
	if err := assistantWriteLicenseState(state); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"success": false, "code": "LICENSE_STATE_UNAVAILABLE"})
		return
	}
	common.ApiSuccess(c, gin.H{"revoked": true, "installation_id": request.InstallationID})
}

func assistantLicenseBytes(payload assistantLicensePayload) []byte {
	bytes, _ := common.Marshal(payload)
	return bytes
}

func assistantLicensePrivateKey() (ed25519.PrivateKey, error) {
	file := os.Getenv("YISAMA_LICENSE_PRIVATE_KEY_FILE")
	if file == "" {
		return nil, os.ErrNotExist
	}
	encoded, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(encoded)))
	if err != nil {
		raw, err = base64.RawStdEncoding.DecodeString(strings.TrimSpace(string(encoded)))
	}
	if err != nil {
		return nil, err
	}
	key, err := x509.ParsePKCS8PrivateKey(raw)
	if err != nil {
		return nil, err
	}
	privateKey, ok := key.(ed25519.PrivateKey)
	if !ok || len(privateKey) != ed25519.PrivateKeySize {
		return nil, os.ErrInvalid
	}
	return privateKey, nil
}

func assistantRandomID() (string, error) {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes[:]), nil
}

func assistantLicenseStatePath() string {
	if file := os.Getenv("YISAMA_LICENSE_STATE_FILE"); file != "" {
		return file
	}
	return "/data/yisama-assistant-license.json"
}

func assistantLicenseRevoked(installationID string) (bool, error) {
	assistantLicenseStateMu.Lock()
	defer assistantLicenseStateMu.Unlock()
	state, err := assistantReadLicenseState()
	if err != nil {
		return false, err
	}
	_, revoked := state.RevokedInstallations[installationID]
	return revoked, nil
}

func assistantReadLicenseState() (assistantLicenseState, error) {
	state := assistantLicenseState{RevokedInstallations: map[string]string{}}
	bytes, err := os.ReadFile(assistantLicenseStatePath())
	if os.IsNotExist(err) {
		return state, nil
	}
	if err != nil {
		return state, err
	}
	if err := common.Unmarshal(bytes, &state); err != nil {
		return state, err
	}
	if state.RevokedInstallations == nil {
		state.RevokedInstallations = map[string]string{}
	}
	return state, nil
}

func assistantWriteLicenseState(state assistantLicenseState) error {
	file := assistantLicenseStatePath()
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		return err
	}
	bytes, err := common.Marshal(state)
	if err != nil {
		return err
	}
	bytes = append(bytes, '\n')
	temporary := file + ".tmp"
	if err := os.WriteFile(temporary, bytes, 0600); err != nil {
		return err
	}
	return os.Rename(temporary, file)
}
