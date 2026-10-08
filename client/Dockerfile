# Stage 1: build the static Vite bundle
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund
COPY . .
# The backend URL is baked in at build time (Vite env vars are compile-time).
# docker-compose.yml passes VITE_API_BASE_URL as a build arg. Default points
# the browser directly at the server's own published port (simplest setup
# for a single-host deployment) - override it if you put this behind a
# reverse proxy or split frontend/backend across different hosts.
ARG VITE_API_BASE_URL=
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN npm run build

# Stage 2: serve the built files with nginx
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
