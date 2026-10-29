package router

import (
	"net/http"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/controller"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/gin-gonic/gin"
)

// The desktop client shares website accounts and session policy, not its CAPTCHA flow.
func setAssistantAuthRoutes(api *gin.RouterGroup) {
	auth := api.Group("/assistant/auth")
	auth.Use(middleware.DisableCache(), middleware.AssistantAuthRateLimit())
	bodyLimit := middleware.AnonymousRequestBodyLimit()
	auth.GET("/options", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"success": true,
			"data": gin.H{
				"password_login_enabled":     common.PasswordLoginEnabled,
				"register_enabled":           common.RegisterEnabled && common.PasswordRegisterEnabled,
				"email_verification_enabled": common.EmailVerificationEnabled,
			},
		})
	})
	auth.POST("/login", middleware.CriticalRateLimit(), bodyLimit, controller.Login)
	auth.POST("/login/2fa", middleware.CriticalRateLimit(), bodyLimit, controller.Verify2FALogin)
	auth.POST("/register", middleware.CriticalRateLimit(), bodyLimit, controller.Register)
	auth.GET("/verification", middleware.EmailVerificationRateLimit(), controller.SendEmailVerification)
}
