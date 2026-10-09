// swiftgrok fronts OpenGrok with a virtual-scroll viewer for large xref files.
package main

import (
	"flag"
	"log"

	"swiftgrok/internal/config"
	"swiftgrok/internal/server"
)

func main() {
	configPath := flag.String("config", "config.json", "path to config file")
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("swiftgrok: %v", err)
	}
	srv, err := server.New(cfg)
	if err != nil {
		log.Fatalf("swiftgrok: %v", err)
	}
	log.Fatal(srv.Run())
}
