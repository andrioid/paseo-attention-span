# Preview the plugin in the real Paseo web app, isolated from the host's Paseo and GitHub.
# Paseo itself is mounted read-only from the host at /opt/paseo; the plugin source at /plugin.
FROM node:24-bookworm-slim
# Chromium brings the libraries the Paseo (Electron) binary needs too.
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium fonts-noto-color-emoji fonts-dejavu-core ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /preview
RUN npm init -y >/dev/null && npm install --no-audit --no-fund playwright-core@1.56.1
COPY entrypoint.sh shoot.mjs plugin-config.json ./
RUN useradd --create-home preview && chmod +x entrypoint.sh
USER preview
ENTRYPOINT ["/preview/entrypoint.sh"]
