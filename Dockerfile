# syntax=docker/dockerfile:1

FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY cmd cmd
COPY internal internal
COPY web web
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/swiftgrok ./cmd/swiftgrok

FROM alpine:3.20
COPY --from=build /out/swiftgrok /usr/local/bin/swiftgrok
EXPOSE 8081
ENTRYPOINT ["swiftgrok", "-config", "/etc/swiftgrok/config.json"]
