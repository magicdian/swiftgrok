// Package web embeds the swiftgrok frontend assets.
package web

import "embed"

//go:embed viewer.js viewer.css portal.html vendor/vue.esm-browser.prod.js
var FS embed.FS
