FROM ytimesy-rehearsal-vm:2
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq xz-utils >/dev/null && rm -rf /var/lib/apt/lists/*
RUN ARCH=$(dpkg --print-architecture | sed 's/amd64/x64/') && curl -fsSL https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-$ARCH.tar.xz | tar -xJ -C /usr/local --strip-components=1
RUN npm i -g pnpm@9.15.0 >/dev/null 2>&1
