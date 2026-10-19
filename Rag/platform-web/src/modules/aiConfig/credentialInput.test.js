import test from 'node:test'
import assert from 'node:assert/strict'
import { savedCredentialText, credentialForSubmission } from './credentialInput.js'
test('saved credential display is never sent as a replacement secret',()=>{const c={configured:true,lastFour:'abcd'};assert.equal(credentialForSubmission(savedCredentialText(c),c),'');assert.equal(credentialForSubmission('new-api-key',c),'new-api-key');assert.equal(savedCredentialText({configured:false}), '');assert.equal(credentialForSubmission('',c),'')})
