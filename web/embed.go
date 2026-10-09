// Package web embeds the swiftgrok viewer frontend assets.
package web

import "embed"

//go:embed viewer.js viewer.css vendor/vue.esm-browser.prod.js
var FS embed.FS
