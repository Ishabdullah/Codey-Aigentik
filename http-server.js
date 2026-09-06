import http from 'http';
import { getEmailProvider } from './email-provider.js';
import logger from './logger.js';

const PORT = 8081;
const HOST = '127.0.0.1';

export function startHttpServer() {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/send-email') {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          const emailProvider = getEmailProvider();
          if (!emailProvider) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Email provider not initialized' }));
            return;
          }
          await emailProvider.sendEmail(data.to, data.subject, data.text, data.html);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (error) {
          logger.error('Error in /send-email:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
        }
      });
    } else if (req.method === 'POST' && req.url === '/send-invite') {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          const emailProvider = getEmailProvider();
          if (!emailProvider) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Email provider not initialized' }));
            return;
          }
          await emailProvider.sendCalendarInvite(data.to, data.appointment, data.text);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (error) {
          logger.error('Error in /send-invite:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
        }
      });
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    }
  });

  server.listen(PORT, HOST, () => {
    logger.info(`Internal HTTP server running at http://${HOST}:${PORT}/`);
  });

  return server;
}
