package router

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func TestAssistantAuthDoesNotChangeWebsiteVerification(t *testing.T) {
	gin.SetMode(gin.TestMode)
	oldTurnstile, oldPassword := common.TurnstileCheckEnabled, common.PasswordLoginEnabled
	oldRegister, oldPasswordRegister := common.RegisterEnabled, common.PasswordRegisterEnabled
	oldRedis, oldCritical := common.RedisEnabled, common.CriticalRateLimitEnable
	common.TurnstileCheckEnabled, common.PasswordLoginEnabled = true, true
	common.RegisterEnabled, common.PasswordRegisterEnabled = false, false
	common.RedisEnabled, common.CriticalRateLimitEnable = false, false
	t.Cleanup(func() {
		common.TurnstileCheckEnabled, common.PasswordLoginEnabled = oldTurnstile, oldPassword
		common.RegisterEnabled, common.PasswordRegisterEnabled = oldRegister, oldPasswordRegister
		common.RedisEnabled, common.CriticalRateLimitEnable = oldRedis, oldCritical
	})
	engine := gin.New()
	setAssistantAuthRoutes(engine.Group("/api"))
	engine.POST("/api/user/login", middleware.TurnstileCheckForPasswordLogin(), func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"success": true})
	})
	for _, tc := range []struct {
		path, body string
		captcha    bool
	}{
		{"/api/user/login", `{}`, true},
		{"/api/assistant/auth/login", `{}`, false},
		{"/api/assistant/auth/register", `{"username":"new","password":"password"}`, false},
		{"/api/assistant/auth/login/2fa", `{}`, false},
	} {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, tc.path, strings.NewReader(tc.body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Forwarded-Proto", "https")
		engine.ServeHTTP(recorder, request)
		require.Equal(t, http.StatusOK, recorder.Code, tc.path)
		var body map[string]interface{}
		require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &body))
		assert.Equal(t, false, body["success"], tc.path)
		assert.Equal(t, tc.captcha, strings.Contains(recorder.Body.String(), "Turnstile"), tc.path)
	}
	assert.True(t, common.TurnstileCheckEnabled)

	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/assistant/auth/options", nil))
	assert.Equal(t, http.StatusOK, recorder.Code)
	assert.Contains(t, recorder.Header().Get("Cache-Control"), "no-store")
	var options struct {
		Success bool `json:"success"`
		Data    struct {
			Password bool `json:"password_login_enabled"`
			Register bool `json:"register_enabled"`
		} `json:"data"`
	}
	require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &options))
	assert.True(t, options.Success)
	assert.True(t, options.Data.Password)
	assert.False(t, options.Data.Register)
}

func TestAssistantAuthRateLimitIsAlwaysEnabled(t *testing.T) {
	oldRedis := common.RedisEnabled
	common.RedisEnabled = false
	t.Cleanup(func() { common.RedisEnabled = oldRedis })
	engine := gin.New()
	setAssistantAuthRoutes(engine.Group("/api"))
	for i := 0; i < 11; i++ {
		request := httptest.NewRequest(http.MethodGet, "/api/assistant/auth/options", nil)
		request.RemoteAddr = "192.0.2.57:1000"
		recorder := httptest.NewRecorder()
		engine.ServeHTTP(recorder, request)
		if i < 10 {
			require.Equal(t, http.StatusOK, recorder.Code)
		} else {
			assert.Equal(t, http.StatusTooManyRequests, recorder.Code)
			assert.NotEmpty(t, recorder.Header().Get("Retry-After"))
		}
	}
}

func TestAssistantAuthUsesExistingAccountsAndKeepsTwoFactorRequired(t *testing.T) {
	require.NoError(t, i18n.Init())
	oldDB, oldLogDB := model.DB, model.LOG_DB
	oldRedis, oldPassword := common.RedisEnabled, common.PasswordLoginEnabled
	oldSecret := common.SessionSecret
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)
	require.NoError(t, db.AutoMigrate(&model.User{}, &model.UserSession{}, &model.AuthFlow{}, &model.TwoFA{}, &model.Log{}))
	model.DB, model.LOG_DB = db, db
	common.RedisEnabled, common.PasswordLoginEnabled = false, true
	common.SessionSecret = "isolated-assistant-session-test-secret"
	t.Cleanup(func() {
		model.DB, model.LOG_DB = oldDB, oldLogDB
		common.RedisEnabled, common.PasswordLoginEnabled = oldRedis, oldPassword
		common.SessionSecret = oldSecret
		sqlDB, err := db.DB()
		require.NoError(t, err)
		require.NoError(t, sqlDB.Close())
	})
	hash, err := common.Password2Hash("shared-password")
	require.NoError(t, err)
	user := model.User{Username: "shared-account", Password: hash, Role: common.RoleCommonUser,
		Status: common.UserStatusEnabled, Group: "default", AuthVersion: 1}
	require.NoError(t, db.Create(&user).Error)
	engine := gin.New()
	setAssistantAuthRoutes(engine.Group("/api"))
	login := func() map[string]interface{} {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/api/assistant/auth/login",
			strings.NewReader(`{"username":"shared-account","password":"shared-password"}`))
		request.RemoteAddr = "192.0.2.80:1000"
		request.Header.Set("Content-Type", "application/json")
		engine.ServeHTTP(recorder, request)
		require.Equal(t, http.StatusOK, recorder.Code)
		var body map[string]interface{}
		require.NoError(t, common.Unmarshal(recorder.Body.Bytes(), &body))
		require.Equal(t, true, body["success"])
		return body["data"].(map[string]interface{})
	}
	first := login()
	assert.NotEmpty(t, first["access_token"])
	assert.Equal(t, float64(user.Id), first["user"].(map[string]interface{})["id"])
	assert.NotContains(t, first["user"], "password")
	require.NoError(t, db.Create(&model.TwoFA{UserId: user.Id, Secret: "unused-in-first-step", IsEnabled: true}).Error)
	second := login()
	assert.Equal(t, true, second["require_2fa"])
	assert.NotEmpty(t, second["flow_token"])
	assert.NotContains(t, second, "access_token")
}
