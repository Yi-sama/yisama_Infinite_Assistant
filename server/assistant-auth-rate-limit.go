package middleware

import "github.com/gin-gonic/gin"

// Remains enabled even when the site's optional critical-request limiter is disabled.
func AssistantAuthRateLimit() gin.HandlerFunc {
	return rateLimitFactory(10, 60, "yisama-assistant-auth:")
}
