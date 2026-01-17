FROM node:18-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY index.js ./

EXPOSE 8080

CMD ["npm", "start"]
