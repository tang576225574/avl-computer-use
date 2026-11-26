ARG DESKTOP_IMAGE=tang576225574/deployer:ubuntu24.04-cuda130-v20261126-accetto
FROM node:24.14.1-bookworm-slim AS build
WORKDIR /opt/avl
COPY package.json package-lock.json ./
COPY frontend/package.json frontend/package.json
RUN npm ci --include=dev
COPY frontend frontend
RUN npm run build && npm prune --omit=dev

FROM ${DESKTOP_IMAGE}
USER root
WORKDIR /opt/avl
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /opt/avl/ /opt/avl/
COPY host host
COPY tools/dsh.sh tools/dsh.sh
COPY container/entrypoint.py container/entrypoint.py
COPY container/ops-sshd container/recover-sshd /usr/local/libexec/avl/
RUN set -eu; \
    chmod 0755 /opt/avl/tools/dsh.sh /usr/local/libexec/avl/ops-sshd /usr/local/libexec/avl/recover-sshd; \
    rm -f /dockerstartup/.initial_sudo_password "/etc/sudoers.d/$HEADLESS_USER_NAME"; \
    for dir in /usr /usr/bin /usr/sbin /usr/lib /usr/lib64 /usr/share /usr/local \
        /usr/local/bin /usr/local/libexec /usr/local/libexec/avl /etc /etc/pam.d /etc/security \
        /etc/ssh /etc/sudoers.d /opt /opt/avl /run /var/lib; do \
      if [ -d "$dir" ]; then chown root:root "$dir"; chmod go-w "$dir"; fi; \
    done; \
    chown root:root /etc/passwd /etc/group /etc/sudoers /etc/sudoers.d/* \
      /usr/sbin/sshd /usr/local/libexec/avl/ops-sshd /usr/local/libexec/avl/recover-sshd; \
    chmod go-w /usr/sbin/sshd /usr/local/libexec/avl/*; \
    chmod 0440 /etc/sudoers /etc/sudoers.d/*; chmod 0644 /etc/passwd /etc/group; \
    useradd --system --no-create-home --shell /usr/sbin/nologin avl-ops; \
    printf '%s\n' "$HEADLESS_USER_NAME ALL=(avl-ops) NOPASSWD: /usr/local/libexec/avl/ops-sshd \"\"" \
      'avl-ops ALL=(root) PASSWD: /usr/local/libexec/avl/recover-sshd ""' \
      'Defaults:avl-ops timestamp_timeout=0' > /etc/sudoers.d/avl-desktop; \
    chmod 0440 /etc/sudoers.d/avl-desktop; visudo -c; \
    test -x /usr/bin/Xvnc; test -x /usr/bin/tini; test -x /usr/bin/vncpasswd
ENV PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin \
    DSH_PORT=3080
EXPOSE 3080
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini","--","/usr/bin/python3","-IS","/opt/avl/container/entrypoint.py"]
CMD []
