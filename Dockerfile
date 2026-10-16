# Use the official Puppeteer image which includes Node.js and Google Chrome
FROM ghcr.io/puppeteer/puppeteer:latest

# Switch to root to copy files and set folder permissions
USER root
WORKDIR /app

# Copy your project files into the container
COPY . .

# Grant the pptruser ownership of the /app directory so it can install modules and save sessions
RUN chown -R pptruser:pptruser /app

# Switch to the safe, non-root user
USER pptruser

# Install NPM dependencies AS pptruser so Chrome goes to /home/pptruser/.cache/puppeteer
RUN npm install

# Explicitly force Puppeteer to install the exact expected Chrome binary
RUN npx puppeteer browsers install chrome

# Expose the port for your web dashboard
EXPOSE 7860

# Start the bot
CMD ["npm", "start"]
