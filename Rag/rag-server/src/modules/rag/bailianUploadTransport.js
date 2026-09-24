const fs = require('fs');
const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');
const axios = require('axios');

const DNS_ERROR_CODES = new Set(['ENOTFOUND', 'ENOENT', 'EAI_AGAIN']);

function parseDnsServers() {
  return (process.env.BAILIAN_UPLOAD_DNS_SERVERS || process.env.OSS_UPLOAD_DNS_SERVERS || '')
    .split(',')
    .map(server => server.trim())
    .filter(Boolean);
}

function isDnsResolutionError(error) {
  return DNS_ERROR_CODES.has(error?.code) || /getaddrinfo/i.test(error?.message || '');
}

function createLookupWithServers(servers) {
  const resolver = new dns.Resolver();
  resolver.setServers(servers);

  return (hostname, options, callback) => {
    const ipFamily = net.isIP(hostname);
    if (ipFamily) {
      if (options?.all) {
        callback(null, [{ address: hostname, family: ipFamily }]);
      } else {
        callback(null, hostname, ipFamily);
      }
      return;
    }

    resolver.resolve4(hostname, (error, addresses) => {
      if (error) {
        callback(error);
        return;
      }

      if (options?.all) {
        callback(null, addresses.map(address => ({ address, family: 4 })));
      } else {
        callback(null, addresses[0], 4);
      }
    });
  };
}

function createAgents(dnsServers) {
  const lookup = createLookupWithServers(dnsServers);
  return {
    httpAgent: new http.Agent({ lookup }),
    httpsAgent: new https.Agent({ lookup })
  };
}

function buildUploadError(error, uploadUrl, dnsServers = []) {
  let hostname = '未知域名';
  try {
    hostname = new URL(uploadUrl).hostname;
  } catch (parseError) {}

  if (!isDnsResolutionError(error)) {
    return error;
  }

  const dnsRetryText = dnsServers.length > 0
    ? `已尝试使用自定义 DNS（${dnsServers.join(', ')}）重试。`
    : '如需临时指定 DNS，可配置 BAILIAN_UPLOAD_DNS_SERVERS=223.5.5.5,119.29.29.29 后重启服务。';

  const wrapped = new Error(
    `上传到阿里云 OSS 失败：服务器无法解析上传域名 ${hostname}（${error.code || 'DNS_ERROR'}）。` +
    `请检查 rag-server 运行环境的 DNS/网络是否可访问 *.oss-cn-beijing.aliyuncs.com。${dnsRetryText}` +
    `原始错误：${error.message}`
  );
  wrapped.code = 'BAILIAN_OSS_UPLOAD_DNS_FAILED';
  wrapped.hostname = hostname;
  wrapped.originalCode = error.code;
  wrapped.cause = error;
  return wrapped;
}

async function putFileToLeaseUrl(uploadUrl, filePath, uploadHeaders) {
  const dnsServers = parseDnsServers();
  const forceCustomDns = process.env.BAILIAN_UPLOAD_FORCE_CUSTOM_DNS === 'true';

  const putOnce = async (agents = {}) => axios.put(uploadUrl, fs.createReadStream(filePath), {
    headers: uploadHeaders,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    ...agents
  });

  try {
    if (forceCustomDns && dnsServers.length > 0) {
      return await putOnce(createAgents(dnsServers));
    }
    return await putOnce();
  } catch (error) {
    if (!forceCustomDns && dnsServers.length > 0 && isDnsResolutionError(error)) {
      try {
        return await putOnce(createAgents(dnsServers));
      } catch (retryError) {
        throw buildUploadError(retryError, uploadUrl, dnsServers);
      }
    }

    throw buildUploadError(error, uploadUrl, forceCustomDns ? dnsServers : []);
  }
}

module.exports = {
  putFileToLeaseUrl
};
