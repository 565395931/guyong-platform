let dispatcher = null
let gatewayLink = null

function setDispatcher(value) { dispatcher = value; global.__cloudGatewayDispatcher = value }
function getDispatcher() { return dispatcher || global.__cloudGatewayDispatcher || null }
function setGatewayLink(value) { gatewayLink = value; global.__cloudGatewayLink = value }
function getGatewayLink() { return gatewayLink || global.__cloudGatewayLink || null }

module.exports = { setDispatcher, getDispatcher, setGatewayLink, getGatewayLink }
