/*
BUG:	waitFor is returning early (possibly associated with error handling)
BUG:	Configure.ps1 is not running correctly
TODO:	Add function Update Security Group with current IP
TODO:	Move questions login from setup into CLI and out of lib
TODO:	Add ability to get current price and show user
TODO:	Change some of the get functions to use newer JS array methods like .find()
TODO:	Optimise to use getActiveInstances() rather than getState() if only active needed
*/

"use strict";

var AWS = require('aws-sdk');
var async = require('async');
var fs = require('fs');
var ursa = require('ursa');
var publicIp = require('public-ip');
var substitute = require('token-substitute');
var reporter = require('../helpers/reporter')();

var config;
var credentials;
var settings = {};
var userDataReader;
var userDataWriter;
var iam;
var ec2;
var ssm;
var kms;
var sts;
var securityKeyPairName = "cloudrig.pem";
var kmsKeyName = "cloudrig4"; // Takes minimum 7 days to delete
var winpwdName = "winpwd";
var kmsRoleName = "cloudrig-kms";
var fleetRoleName = "cloudrig-spotfleet";
var ssmRoleName = "cloudrig-ssm";
var publicKeyName = "instance.pub";
var standardFilter = [{
	Name: 'tag:cloudrig',
	Values: ['true']
}];

//--------------------------------------------------
// Get
//--------------------------------------------------

function getPS1(script) {
	return fs.readFileSync(__dirname + "/ps1/" + script).toString();
}

function getFleetRole(cb) {

	reporter.report("Finding Fleet Role");

	iam.listRoles({}, function(err, data) {
		
		if (err) {
			cb(err); 
		} else  {
			for(var i = 0; i < data.Roles.length; i++) {
				
				if(data.Roles[i].RoleName == fleetRoleName) {
					cb(null, data.Roles[i]);
					return;
				}
			}
			cb(null);
		}
	});

}

function getInstanceProfiles(cb) {

	iam.listInstanceProfiles({}, function(err, data) {
		
		if (err) {
			cb(err);
			return;
		}

		cb(null, data.InstanceProfiles);

	});
}

function getAMI(cb) {

	reporter.report("Finding AMI");

	ec2.describeImages({
		Owners: ['self'],
		Filters: standardFilter
	}, function(err, data) {
		
		if (err) {
			cb(err); 
		} else {
			cb(null, data.Images[0]);
		}

	});

}

function getSSMRole(cb) {

	reporter.report("Finding SSM Role");

	var ret = {};

	async.series([

		(cb) => {

			iam.listRoles({}, function(err, data) {

				if (err) {
					cb(err);
					return;
				}

				data.Roles.forEach((role, i) => {

					if(role.RoleName == ssmRoleName) {

						ret.Role = role;

					}
					
				});

				cb(null);

			});

		},

		(cb) => {

			getInstanceProfiles((err, instanceProfiles) => {
				
				if (err) {
					cb(err);
					return;
				}

				instanceProfiles.forEach((profile, i) => {

					if(profile.InstanceProfileName == ssmRoleName) {

						ret.InstanceProfile = profile;

					}
					
				});

				cb(null);

			});

		}

	], (err, results) => {

		if(err) {
			cb(err);
			return;
		}

		cb(null, ret);

	});	

}

function getKMSRole(cb) {
	
	reporter.report("Finding KMS Role");

	iam.listRoles({}, function(err, data) {
		
		if (err) {
			cb(err);
			return;
		}
		for(var i = 0; i < data.Roles.length; i++) {
			
			if(data.Roles[i].RoleName == kmsRoleName) {
				cb(null, data.Roles[i]);
				return;
			}
		}
		cb(null);
	
	});
}

function getIdFromCredentials(cb) {

	reporter.report("Getting ID from credentials");

	sts.getCallerIdentity({}, function(err, data) {

		if(err) {
			cb(err);
			return;
		}

		cb(null, data);

	});

}

function getSecurityGroup(cb) {

	reporter.report("Finding Security Group");

	ec2.describeSecurityGroups({
		Filters: standardFilter
	}, function(err, data) {
		
		if (err) {
			cb(err); 
		} else {
			cb(null, data.SecurityGroups[0]);
		}
		
	});
}

function getKeyPair(cb) {

	reporter.report("Finding Key Pair");

	ec2.describeKeyPairs({
		KeyNames: ["cloudrig"]
	}, function(err, data) {
		// Error if there are no keys
		// TODO: Warn if there's more than 1
		if (err) {
			cb(null, null); 
		} else {
			cb(null, data.KeyPairs[0]);
		}
		
	});
}

function getActiveInstances(cb) {

	ec2.describeInstances({
		Filters: standardFilter.concat([{
			Name: 'instance-state-name',
			Values: ['running']
		}])
	}, function(err, data) {
		
		if (err) {
			cb(err);
		} else {
			cb(null, data.Reservations[0] ? data.Reservations[0].Instances : []);
		}

	});

}

function getSpotFleetInstances(SpotFleetRequestId, cb) {

	ec2.describeSpotFleetInstances({
		SpotFleetRequestId: SpotFleetRequestId
	}, function(err, data) {
		if (err) {
			cb(err); 
		} else {
			cb(null, data.ActiveInstances);
		}

	});

}

function getPendingInstances(cb) {

	ec2.describeInstances({
		Filters: standardFilter.concat([{
			Name: 'instance-state-name',
			Values: ['pending']
		}])
	}, function(err, data) {
		
		if (err) {
			cb(err); 
		} else {
			cb(null, data.Reservations[0] ? data.Reservations[0].Instances : []);
		}

	});

}

function getShuttingDownInstances(cb) {
	
	ec2.describeInstances({
		Filters: standardFilter.concat([{
			Name: 'instance-state-name',
			Values: ['shutting-down']
		}])
	}, function(err, data) {
		
		if (err) {
			cb(err); 
		} else {
			cb(null, data.Reservations[0] ? data.Reservations[0].Instances : []);
		}

	});

}

function getPassword(cb) {

	reporter.report(`Getting password from ${winpwdName}`);

	var pwdData = userDataReader(winpwdName);

	kms.decrypt({
		CiphertextBlob: pwdData
	}, function(err, data) {
		if(err) {
			cb(err);
			return;
		}
		cb(null, data.Plaintext);
	});

}

function getPublicDNS(cb) {
	getState(function(err, state) {
		if(err) {
			cb(err);
			return;
		}
		cb(null, state.activeInstances[0].PublicDnsName);
	});
}

function getEncryptionKey(cb) {

	reporter.report("Finding Encryption Key");

	kms.listAliases({}, (err, data) => {

		if(err) {
			cb(err);
			return;
		}

		var alias = data.Aliases.find((alias)=> { return alias.AliasName == "alias/" + kmsKeyName; });

		if(alias) {
			cb(null, alias.TargetKeyId);
		} else {
			cb(null, null);
		}

	});

}

function getBaseAMI(cb) {

	reporter.report("Finding Base AMI")

	ec2.describeImages({
		Owners: ['amazon'],
		Filters: [{
			Name: 'name',
			Values: ['Windows_Server-2016-English-Full-Base-*']
		}]
	}, function(err, data) {
		if (err) {
			cb(err);
			return;
		}
		cb(null, data.Images[data.Images.length - 1]);
	});

}

//--------------------------------------------------
// Create
//--------------------------------------------------

function createSecurityGroup(cb) {
	
	reporter.report("Creating security group");
	
	publicIp.v4().then(function(ip) {

		ec2.createSecurityGroup({
			Description: "cloudrig",
			GroupName: "cloudrig"
		}, function(err, securityGroupData) {

			if (err) {

				reporter.report(err.stack, "error");

			} else {
				
				ec2.authorizeSecurityGroupIngress({
					GroupId: securityGroupData.GroupId,
					IpPermissions: [{
						FromPort: -1,
						ToPort: -1,
						IpProtocol: '-1',
						IpRanges: [
							{ CidrIp: ip + "/32" }
						]
					}]
				}, function (err, data) {

					if (err) {

						reporter.report(err.stack, "error");

					} else {
						reporter.report("Tagging");
						createTags(securityGroupData.GroupId, null, cb);
					}

				});

			}
			
		});

	});
	
}

function createFleetRole(cb) {

	async.series([

		(cb) => {

			var policy = `{
				"Version": "2012-10-17",
				"Statement": {
					"Effect": "Allow",
					"Principal": {
						"Service": "spotfleet.amazonaws.com"
					},
					"Action": "sts:AssumeRole"
				}
			}`;

			reporter.report(`Creating fleet role '${fleetRoleName}'`);

			iam.createRole({
				AssumeRolePolicyDocument: policy,
				Path: "/", 
				RoleName: fleetRoleName
			}, cb);

		},

		(cb) => {

			var policy = "arn:aws:iam::aws:policy/service-role/AmazonEC2SpotFleetRole";

			reporter.report(`Attaching the policy '${policy}'`);
			
			iam.attachRolePolicy({
				PolicyArn: policy, 
				RoleName: fleetRoleName
			}, cb);

		}


	], cb);

}

function createSSMRole(cb) {
	
	async.series([

		(cb) => {

			var policy = `{
				"Version": "2012-10-17",
				"Statement": {
					"Effect": "Allow",
					"Principal": {
						"Service": "ec2.amazonaws.com",
						"Service": "ssm.amazonaws.com"
					},
					"Action": "sts:AssumeRole"
				}
			}`;

			reporter.report(`Creating SSM role '${ssmRoleName}'`);

			iam.createRole({
				AssumeRolePolicyDocument: policy,
				Path: "/", 
				RoleName: ssmRoleName
			}, cb);

		},

		(cb) => {

			var policy = "arn:aws:iam::aws:policy/service-role/AmazonEC2RoleforSSM";

			reporter.report(`Attaching the policy '${policy}'`);

			iam.attachRolePolicy({
				PolicyArn: policy, 
				RoleName: ssmRoleName
			}, cb);

		},

		(cb) => {

			var policy = "arn:aws:iam::aws:policy/AmazonSNSFullAccess";

			reporter.report("Attaching the policy '" + policy + "'");

			iam.attachRolePolicy({
				PolicyArn: policy, 
				RoleName: ssmRoleName
			}, cb);

		},

		(cb) => {

			reporter.report(`Creating instance profile '${ssmRoleName}'`);

			iam.createInstanceProfile({
				InstanceProfileName: ssmRoleName
			}, cb);

		},

		(cb) => {

			reporter.report(`Adding role '${ssmRoleName}' to instance profile '${ssmRoleName}'`);

			iam.addRoleToInstanceProfile({
				InstanceProfileName: ssmRoleName, 
				RoleName: ssmRoleName
			}, cb);

		}

	], cb);

}

function createKMSRole(cb) {

	async.series([

		(cb) => {

			var policy = `{
				"Version": "2012-10-17",
				"Statement": {
					"Effect": "Allow",
					"Principal": {
						"Service": "ec2.amazonaws.com"
					},
					"Action": "sts:AssumeRole"
				}
			}`;

			reporter.report(`Creating KMS role '${kmsRoleName}'`);

			iam.createRole({
				AssumeRolePolicyDocument: policy,
				Path: "/", 
				RoleName: kmsRoleName
			}, cb);

		},

		(cb) => {

			var policy = "arn:aws:iam::aws:policy/AWSKeyManagementServicePowerUser";

			reporter.report(`Attaching the policy '${policy}'`);

			iam.attachRolePolicy({
				PolicyArn: policy, 
				RoleName: kmsRoleName
			}, cb);

		},

	], cb);

}

function createKeyPair(cb) {
	
	ec2.createKeyPair({
		KeyName: "cloudrig"
	}, function(err, data) {
		
		if (err) {
			reporter.report(err.stack, "error");
			cb("error");
		} else {
			cb(data);
		}

	});
	
}

function createEncryptionKey(cb) {
	
	//http://stackoverflow.com/questions/10197784/how-can-i-deduce-the-aws-account-id-from-available-basicawscredentials
	// get credentials ARN

	reporter.report("Creating Encryption Key");

	async.waterfall([

		(cb) => {
			
			kms.createKey({
				Tags: [{
					TagKey: kmsKeyName, 
					TagValue: "true"
				}],
				Policy: `{
					"Id": "key-consolepolicy-3",
					"Version": "2012-10-17",
					"Statement": [
						{
						"Sid": "Enable IAM User Permissions",
						"Effect": "Allow",
						"Principal": {
							"AWS": [
								"${settings.mainUserId}"
							]
						},
						"Action": "kms:*",
						"Resource": "*"
						},
						{
						"Sid": "Allow access for Key Administrators",
						"Effect": "Allow",
						"Principal": {
							"AWS": [
								"${settings.kmsRole}"
							]
						},
						"Action": [
							"kms:Create*",
							"kms:Describe*",
							"kms:Enable*",
							"kms:List*",
							"kms:Put*",
							"kms:Update*",
							"kms:Revoke*",
							"kms:Disable*",
							"kms:Get*",
							"kms:Delete*",
							"kms:TagResource",
							"kms:UntagResource",
							"kms:ScheduleKeyDeletion",
							"kms:CancelKeyDeletion"
						],
						"Resource": "*"
						},
						{
						"Sid": "Allow use of the key",
						"Effect": "Allow",
						"Principal": {
							"AWS": [
								"${settings.kmsRole}"
							]
						},
						"Action": [
							"kms:Encrypt",
							"kms:Decrypt",
							"kms:ReEncrypt*",
							"kms:GenerateDataKey*",
							"kms:DescribeKey"
						],
						"Resource": "*"
						},
						{
						"Sid": "Allow attachment of persistent resources",
						"Effect": "Allow",
						"Principal": {
							"AWS": [
								"${settings.kmsRole}"
							]
						},
						"Action": [
							"kms:CreateGrant",
							"kms:ListGrants",
							"kms:RevokeGrant"
						],
						"Resource": "*",
						"Condition": {
							"Bool": {
							"kms:GrantIsForAWSResource": true
							}
						}
						}
					]
				}`
			}, function(err, data) {

				if (err) {
					cb(err);
					return;
				}
				
				cb(null, data.KeyMetadata.KeyId);
				
			});

		},
		(keyId, cb) => {

			reporter.report("Creating Alias");

			kms.createAlias({
				AliasName: "alias/" + kmsKeyName,
				TargetKeyId: keyId
			}, (err, data) => {

				if (err) {
					cb(err);
					return;
				}
				
				cb(null);
				
			});

		}

	], (err, results) => {

		if (err) {
			reporter.report(err.stack, "error");
			cb(err);
			return;
		}
		
		cb(null);

	});

}

function createRemoteEncryptedFile(data, cb) {

	var cmd = getPS1("Create-Encrypted-File.ps1");

	var publicKey = userDataReader(publicKeyName);

	var key = ursa.createPublicKey(publicKey);

	var input = key.encrypt(data, "utf8", "base64");
	
	cmd = cmd.replace('{{input}}', input);

	sendMessage(cmd, (err, tmpFileRef) => {
		if(err) {
			cb(err);
			return;
		}
		cb(null, tmpFileRef);
	});

}

function createSteamShortcut(steamid, password, cb) {

	reporter.report("Creating Steam Shortcut");
	
	createRemoteEncryptedFile(steamid + "," + password, (err, file) => {

		var cmd = getPS1("Create-Steam-Shortcut.ps1");

		cmd = cmd.replace(new RegExp("{{input}}", "g"), file.replace(/(\r\n|\n|\r)/gm,""));
		
		sendMessage(cmd, (err) => {

			if(err) {
				cb(err);
				return;
			}
			cb(null);

		});

	});

}

//--------------------------------------------------
// Helpers
//--------------------------------------------------

function createTags(resourceId, additionalTags, cb) {

	var tags = [{
		Key: "cloudrig", 
		Value: "true"
	}];

	if(additionalTags) {
		tags = tags.concat(additionalTags);
	}

	ec2.createTags({
		Resources: [resourceId], 
		Tags: tags
	}, function(err, data) {
		
		if (err) {
			reporter.report(err.stack, "error");
			cb(err);
			return;
		}

		cb(null, data);
		
	});

}

//--------------------------------------------------
// Update
//--------------------------------------------------

function updateAMI(cb) {
	
	reporter.report("Creating image");

	getState(function(err, state) {

		if(err) {
			cb(err);
			return;
		}

		ec2.createImage({
			InstanceId: state.activeInstances[0].InstanceId,
			Name: 'cloudrig-' + new Date().getTime(),
			NoReboot: true
		}, function(err, data) {
			
			if (err) {
				reporter.report(err.stack, "error");
				cb(err);
				return;
			}
			
			reporter.report("Waiting for image to be available");

			var newImageId = data.ImageId;

			ec2.waitFor('imageAvailable', {
				ImageIds: [newImageId]
			}, function() {
				
				reporter.report("Removing tag from " + settings.ImageId);

				async.parallel([
					deleteTags.bind(null, settings.ImageId),
					createTags.bind(null, newImageId, null)
				], (err) => {

					if (err) {
						reporter.report(err.stack, "error");
						cb(err);
						return;
					}

					cb(null);

				});

			});

		});

	});
	
}

// TODO: Implement
function updateSecurityGroup(cb) {
	// revokeSecurityGroupEgress
}

//--------------------------------------------------
// Delete
//--------------------------------------------------

function deleteInstanceProfile(instanceProfileName, cb) {

	iam.deleteInstanceProfile({
		InstanceProfileName: instanceProfileName
	}, cb);
	
}

function deleteAMI(amiId, cb) {

	if(settings.fromBase) {
		reporter.report("Can't delete the base image");
		cb(null);
		return;
	}

	// NOT IMPLEMENTED
	cb(null, true);

}

function deleteTags(resourceId, cb) {

	var params = {
		Resources: [resourceId], 
		Tags: [{
			Key: "cloudrig", 
			Value: "true"
		}]
	};
	
	ec2.deleteTags(params, (err, data) => {
		
		if (err) {
			reporter.report(err.stack, "error");
			cb(err);
			return;
		}

		cb(null, data);
		
	});

}

//--------------------------------------------------
// IService
//--------------------------------------------------

function getState(cb) {
	
	async.parallel([
		
		getActiveInstances,
		getPendingInstances,
		getShuttingDownInstances

	], (err, results) => {
		
		if(err) {
			cb(err);
			return;
		}

		cb(null, {
			activeInstances: results[0],
			pendingInstances: results[1],
			shuttingDownInstances: results[2]
		});

	});

}

function getRequiredConfig() {
	return ["AWSCredentialsProfile", "AWSMaxPrice", "AWSRegion"];
}

function validateRequiredConfig(configValues, cb) {

	var testCredentials = new AWS.SharedIniFileCredentials({
		profile: configValues[0]
	});
	
	if(!credentials.accessKeyId) {
		cb(null, ["AWS profile not found"]);
	} else {
		cb(null, true);
	}

	/*
	TODO: Investigate running all setup commands but with DryRun parameter set
	
	*/

}

function validateRequiredSoftware(cb) {
	cb(null, true);
}

//--------------------------------------------------
// Instance
//--------------------------------------------------

function start(cb) {

	var params = {
		SpotFleetRequestConfig: {
			IamFleetRole: settings.fleetRole,
			LaunchSpecifications: [{
				IamInstanceProfile: {
					Arn: settings.ssmInstanceProfile
				},
				ImageId: settings.ImageId,
				InstanceType: "g2.2xlarge",
				KeyName: settings.KeyName,
				SecurityGroups: [{
					GroupId: settings.SecurityGroupId
				}]

			}],
			Type: "request",
			SpotPrice: config.AWSMaxPrice || "0.4", 
			TargetCapacity: 1
		}
		
	};

	if(settings.fromBase) {
		params.SpotFleetRequestConfig.LaunchSpecifications[0].BlockDeviceMappings = [{
			DeviceName: "/dev/sda1", 
			Ebs: {
				DeleteOnTermination: true, 
				VolumeSize: 256, 
				VolumeType: "gp2"
			}
		}];
	}

	var startFunctions = [

		(cb) => {

			ec2.requestSpotFleet(params, function(err, data) {

				if (err) {
					reporter.report(err.stack, "error");
					cb(err);
				} else {
				
					reporter.report("Request made: " +  data.SpotFleetRequestId);
					cb(null, data.SpotFleetRequestId);

				}
				
			});

		},
		(spotFleetRequestId, cb) => {

			reporter.report("Waiting for fulfillment");

			var c = setInterval(function() {

				getSpotFleetInstances(spotFleetRequestId, function(err, instances) {
					
					if(err) {
						reporter.report(err);
						clearInterval(c);
						cb(err);
					} else {

						if(instances.length > 0) {

							clearInterval(c);

							var instanceId = instances[0].InstanceId;

							cb(null, instanceId);
						}

					}

				});

			}, 5000);

		},
		(instanceId, cb) => {

			reporter.report("Tagging instance");

			createTags(instanceId, null, (err) => {
				
				if (err) { 
					reporter.report(err, "error");
					cb(err);
				} else {
					cb(null, instanceId);
				}
	

			});

		},
		(instanceId, cb) => {

			reporter.report("Waiting for our instance to be ready");

			var c = setInterval(function() {

				getActiveInstances(function(err, instances) {
					
					if(instances.length > 0) {
						
						clearInterval(c);

						reporter.report("Waiting for our instance to be OK");

						ec2.waitFor('instanceStatusOk', {
							InstanceIds: [ instanceId ]
						}, function(err, data) {
							
							if (err) { 
								reporter.report(err, "error");
								cb(err);
							} else {
								cb(null, instances[0]);
							}

						});
					}

				});

			}, 5000);


		},
		(instance, cb) => {

			reporter.report("Waiting for SSM");

			var c = setInterval(() => {

				ssm.describeInstanceInformation({
					Filters: [{
						Key: "InstanceIds",
						Values: [instance.InstanceId]
					}]
				}, function(err, data) {
					
					if (err) {
						reporter.report(err, "error");
						cb(err);
					} else {
						
						if(data.InstanceInformationList.length > 0) {

							clearInterval(c);
							cb(null, instance);

						}

					}
					
				});

			}, 2000);

		}

	];

	if(settings.fromBase) {

		startFunctions = startFunctions.concat([
			
			(instance, cb) => {

				reporter.report("Performing first time setup. This may take a while.");

				reporter.report("Sussing out the password");

				// Because this is from the base instance, we use the keypair to get the password
				// We then use KMS to store and retrieve it from then on because you can't use the keypair
				// after the base AMI is copied (PasswordData is blank)
				// See README.md for more on the drama of snapshot vs persistent storage vs updating AMI

				reporter.report(`Getting password using private key '${securityKeyPairName}'`);

				var pem = userDataReader(securityKeyPairName);
				var pkey = ursa.createPrivateKey(pem);

				ec2.getPasswordData({InstanceId: instance.InstanceId}, function (err, data) {
					
					if(err) {
						cb(err);
						return;
					}

					var password = pkey.decrypt(data.PasswordData, 'base64', 'utf8', ursa.RSA_PKCS1_PADDING);

					reporter.report("Encrypting and setting password");

					kms.encrypt({
						KeyId: settings.encryptionKey,
						Plaintext: password
					}, (err, data) => {

						if(err) {
							cb(err);
							return;
						}

						reporter.report(`Saving encrypted password to ${winpwdName}`);

						userDataWriter(winpwdName, data.CiphertextBlob);

						cb(null, instance);

					});

				});

			},

			// TODO: Expose these are "private" methods for maintenance or Advanced

			(instance, cb) => {
				reporter.report("Creating cloudRIG Folder");
				sendMessage(getPS1("Create-Folder.ps1"), () => { cb(null, instance); });
			},

			(instance, cb) => {
				reporter.report("Installing Steam");
				sendMessage(getPS1("Install-Steam.ps1"), () => { cb(null, instance); });
			},
			
			(instance, cb) => {
				reporter.report("Installing ZeroTier (VPN)");
				sendMessage(getPS1("Install-ZeroTier.ps1"), () => { cb(null, instance); });
			},
			
			(instance, cb) => {
				reporter.report("Installing Graphics Driver");
				sendMessage(getPS1("Install-Graphics-Driver.ps1"), () => { cb(null, instance); });
			},

			(instance, cb) => {
				reporter.report("Installing Device Management");
				sendMessage(getPS1("Install-Device-Management.ps1"), () => { cb(null, instance); });
			},

			(instance, cb) => {
				reporter.report("Installing Sound Driver");
				sendMessage(getPS1("Install-Sound-Driver.ps1"));
				// BUG: This not returning
				setTimeout(() => { cb(null, instance); }, 3000);
			},

			(instance, cb) => {
				reporter.report("Installing Open SSL");
				sendMessage(getPS1("Install-OpenSSL.ps1"), () => { cb(null, instance); });
			},

			(instance, cb) => {
				reporter.report("Getting Public Key");
				sendMessage(getPS1("Get-PublicKey.ps1"), (err, publicKey) => {
					userDataWriter(publicKeyName, publicKey);
					cb(null, instance);
				});
			},
			
			// TODO: Some of this config doesn't look to be working (perhaps associated with user profile generation)
			(instance, cb) => {
				reporter.report("Configuring");
				sendMessage(getPS1("Configure.ps1"), () => { cb(null, instance); });
			},

			(instance, cb) => {

				reporter.report("Rebooting");

				ec2.rebootInstances({
					InstanceIds: [ instance.InstanceId ]
				}, (err) => {

					if (err) { 
						reporter.report(err, "error");
						cb(err);
						return;
					}
					// TODO: Check this out so it doesn't return early
					setTimeout(() => {

						ec2.waitFor('instanceStatusOk', {
							InstanceIds: [ instance.InstanceId ]
						}, function(err, data) {
							
							if (err) { 
								reporter.report(err, "error");
								cb(err);
								return;
							}
							cb(null, instance);
							

						});

					}, 2000);

				});
				
			}

		]);

	}

	async.waterfall(startFunctions, (err, data) => {

		if (err) { 
			reporter.report(err.stack, "error");
			cb(err);
			return;
		}
		
		cb(null);

	});

	return params;

}

function stop(cb) {

	getState(function(err, state) {

		if(err) {
			cb(err);
			return;
		}

		var id;
		
		state.activeInstances[0].Tags.forEach(function(tag) {

			if(tag.Key === "aws:ec2spot:fleet-request-id") {
				id = tag.Value;
			}
		});

		reporter.report("Stopping: \t" + id);

		ec2.cancelSpotFleetRequests({
			SpotFleetRequestIds: [id], 
			TerminateInstances: true
		}, function(err, data) {
			
			if (err) {
				reporter.report(err.stack, "error");
				cb(err);
			} else {

				reporter.report("Waiting for instance to be terminated");

				ec2.waitFor('instanceTerminated', {
					
					InstanceIds: [state.activeInstances[0].InstanceId]

				}, function() {

					reporter.report("Terminated");
					cb(null);

				});
				
			}

		});

	});

}

function sendMessage(commands, cb) {

	commands = !Array.isArray(commands) ? [commands] : commands;

	getState(function(err, state) {
		
		if(err) {
			cb(err);
			return;
		}

		var instanceId = state.activeInstances[0].InstanceId;

		var params = {
			DocumentName: "AWS-RunPowerShellScript",
			InstanceIds: [
				instanceId
			],
			ServiceRoleArn: settings.ssmRole,
			Parameters: {
				"commands": commands
			}
		};

		ssm.sendCommand(params, function(err, data) {
			
			if(err) {
				cb(err);
				return;
			}

			function check() {

				
				ssm.listCommandInvocations({
					CommandId: data.Command.CommandId,
					InstanceId: instanceId,
					Details: true
				}, function(err, data) {
					

					if(err) {
						cb(err);
						return;
					}
					
					if(
						data.CommandInvocations && 
						data.CommandInvocations.length > 0 && 
						data.CommandInvocations[0].Status == "Success" &&
						!!data.CommandInvocations[0].CommandPlugins[0].Output
					) {
						
						cb(null, data.CommandInvocations[0].CommandPlugins[0].Output);

					} else {

						setTimeout(check, 2000);
						
					}

				});

			}
			
			check();

		});
		

	});

}

module.exports = {
	
	id: "AWS",

	//--------------------------------------------------
	// IService
	//--------------------------------------------------

	getRequiredConfig: getRequiredConfig,

	getState: getState,

	setConfig: function(_config) {
		config = _config;
	},

	setReporter: function(_reporter) {
		reporter.set(_reporter, "AWS");
	},

	validateRequiredConfig: validateRequiredConfig,

	validateRequiredSoftware: validateRequiredSoftware,

	setup: function(_userDataReader, _userDataWriter, cb) {
		
		userDataReader = _userDataReader;
		userDataWriter = _userDataWriter;

		credentials = new AWS.SharedIniFileCredentials({
			profile: config.AWSCredentialsProfile
		});
		
		AWS.config.credentials = credentials;
		AWS.config.region = config.AWSRegion;

		iam = new AWS.IAM();
		ec2 = new AWS.EC2();
		ssm = new AWS.SSM();
		kms = new AWS.KMS();
		sts = new AWS.STS();
		
		async.parallel([
			getFleetRole,
			getSSMRole,
			getAMI,
			getSecurityGroup,
			getKeyPair,
			getEncryptionKey,
			getKMSRole,
			getIdFromCredentials,
			getBaseAMI
		], function(err, results) {

			if(err) {
				cb("Error " + err);
				return;
			}

			var fleetRole = results[0];
			var ssmRole = results[1];
			var ami = results[2];
			var securityGroup = results[3];
			var keyPair = results[4];
			var encryptionKey = results[5];
			var kmsRole = results[6];
			var mainUserId = results[7];
			var baseAMI = results[8];

			settings.mainUserId = mainUserId.Arn;
			
			var questions = [];

			if(!fleetRole) {
				questions.push({
					q: "Shall I make a role called '" + fleetRoleName + "' for Spot Fleet requests?",
					m: createFleetRole.bind(this)
				});
			} else {
				settings.fleetRole = fleetRole.Arn;
			}

			if(!ssmRole || (ssmRole && !ssmRole.Role)) {
				questions.push({
					q: "Shall I make a role and instance profile called '" + ssmRoleName + "' for SSM communication?",
					m: createSSMRole.bind(this)
				});
			} else {
				settings.ssmInstanceProfile = ssmRole.InstanceProfile.Arn;
				settings.ssmRole = ssmRole.Role.Arn;
			}

			if(!ami) {
				settings.fromBase = true;
				settings.ImageId = baseAMI.ImageId;
			} else {
				settings.ImageId = ami.ImageId;
			}

			if(!keyPair) {
				questions.push({
					q: "Shall I make a Key Pair called 'cloudrig'?",
					m: function(cb) {

						createKeyPair((data) => {

							userDataWriter(securityKeyPairName, data.KeyMaterial);
							reporter.report("PEM saved " + securityKeyPairName);

							cb(null);
							
						});
					}.bind(this)
				});
			} else {
				settings.KeyName = keyPair.KeyName;
			}

			if(!securityGroup) {
				questions.push({
					q: "Shall I make a CloudRig security group for you?",
					m: createSecurityGroup.bind(this)
				});
			} else {
				settings.SecurityGroupId = securityGroup.GroupId;
			}

			if(!kmsRole) {
				questions.push({
					q: "Shall I make a role called '" + kmsRoleName + "' for KMS (key management)?",
					m: createKMSRole.bind(this)
				});
			} else {
				settings.kmsRole = kmsRole.Arn;
			}

			if(kmsRole && !encryptionKey) {
				questions.push({
					q: "Shall I make an encryption key for you? It's for retrieving your Windows password",
					m: createEncryptionKey.bind(this)
				});
			} else {
				settings.encryptionKey = encryptionKey;
			}
			
			cb(null, questions, settings);

		});

	},

	_maintenance: function(cb) {

		credentials = new AWS.SharedIniFileCredentials({
			profile: config.AWSCredentialsProfile
		});
		
		AWS.config.credentials = credentials;
		AWS.config.region = config.AWSRegion;

		iam = new AWS.IAM();
		ec2 = new AWS.EC2();
		ssm = new AWS.SSM();
		kms = new AWS.KMS();

		cb(null);

	},

	//--------------------------------------------------
	// Instance
	//--------------------------------------------------
	
	getActive: getActiveInstances,

	getPending: getPendingInstances,

	getShuttingDownInstances: getShuttingDownInstances,

	getPublicDNS: getPublicDNS,

	getPassword: getPassword,

	getAMI: getAMI,

	start: start,

	stop: stop,

	deleteAMI: deleteAMI,

	updateAMI: updateAMI,

	sendMessage: sendMessage,

	createSteamShortcut: createSteamShortcut, // TODO: Consider putting into Steam (or rename steam.js to steamclient.js)

	_getInstanceProfiles: getInstanceProfiles,

	_deleteInstanceProfile: deleteInstanceProfile,
	
	_createSecurityGroup: createSecurityGroup,

	_createKeyPair: createKeyPair,

};