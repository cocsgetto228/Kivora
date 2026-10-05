# Multi-stage: the result is the binary and a certificate bundle, nothing else.
# There is no shell in the final image, which removes a whole class of "attacker
# got RCE and then ran something" from the picture.

FROM node:22-alpine AS web
WORKDIR /src
COPY web/package.json web/
COPY packages/kivora-crypto/package.json packages/kivora-crypto/
RUN cd web && npm install --no-audit --no-fund
COPY packages/ packages/
COPY web/ web/
RUN cd web && npm run build

FROM golang:1.24-alpine AS server
WORKDIR /src
COPY server/go.mod server/
RUN cd server && go mod download
COPY server/ server/
COPY --from=web /src/web/dist/ server/internal/webui/dist/
ARG VERSION=0.1.0
RUN cd server && CGO_ENABLED=0 go build -trimpath \
    -ldflags "-s -w -X github.com/kivora-im/kivora/server/internal/api.Version=${VERSION}" \
    -o /kivorad ./cmd/kivorad

FROM scratch
COPY --from=server /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=server /kivorad /kivorad

ENV KIVORA_ADDR=:8080 \
    KIVORA_DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 8080
USER 10001:10001
ENTRYPOINT ["/kivorad"]
