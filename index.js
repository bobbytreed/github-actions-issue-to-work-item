const core = require(`@actions/core`);
const github = require(`@actions/github`);
const azdev = require(`azure-devops-node-api`);
const fetch = require('node-fetch');
const jp = require('jsonpath');

const debug = false; // debug mode for testing...always set to false before doing a commit
const testPayload = []; // used for debugging, cut and paste payload

main();

async function main() {
	try {
		const context = github.context;
		const env = process.env;

		let vm = [];

		if (debug) {
			// manually set when debugging
			env.ado_organization = "{organization}";
			env.ado_token = "{azure devops personal access token}";
			env.github_token = "{github token}";
			env.ado_project = "{project name}";
			env.ado_wit = "User Story";
			env.ado_close_state = "Closed";
			env.ado_new_state = "New";
			env.id_mapping_url = "{id mapping api that ends with '/'. github username will be appended for the query}";
			env.id_mapping_pat = "id mapping api's token";
			env.id_mapping_query = "jsonpath query to get the unique id from the json response";
	
			console.log("Set values from test payload");
			vm = getValuesFromPayload(testPayload, env);
		} else {
			console.log("Set values from payload & env");
			vm = getValuesFromPayload(github.context.payload, env);
		}

		// todo: validate we have all the right inputs

		// go check to see if work item already exists in azure devops or not
		// based on the title and tags
		console.log("Check to see if work item already exists");
		let workItem = await find(vm);
		let issue = "";

		// if workItem == -1 then we have an error during find
		if (workItem === -1) {
			core.setFailed();
			return;
		}

		// if a work item was not found, go create one
		if (workItem === null) {
			console.log("No work item found, creating work item from issue");
			workItem = await create(vm);

			// if workItem == -1 then we have an error during create
			if (workItem === -1) {
				core.setFailed();
				return;
			}

			// link the issue to the work item via AB# syntax with AzureBoards+GitHub App
			issue = vm.env.ghToken != "" ? await updateIssueBody(vm, workItem) : "";
		} else {
			console.log(`Existing work item found: ${workItem.id}`);
		}

		// create right patch document depending on the action tied to the issue
		// update the work item
		switch (vm.action) {
			case "opened":
				workItem === null ? await create(vm) : "";
				break;
			case "edited":
				workItem != null ? await update(vm, workItem) : "";
				break;
			case "created": // adding a comment to an issue
				workItem != null ? await comment(vm, workItem) : "";
				break;
			case "closed":
				workItem != null ? await close(vm, workItem) : "";
				break;
			case "reopened":
				workItem != null ? await reopen(vm, workItem) : "";
				break;
			case "assigned":
				workItem != null ? await assign(vm, workItem) : "";
				break;
			case "labeled":
				workItem != null ? await label(vm, workItem) : "";
				break;
			case "unlabeled":
				workItem != null ? await unlabel(vm, workItem) : "";
				break;
			case "deleted":
				console.log("deleted action is not yet implemented");
				break;
			case "transferred":
				console.log("transferred action is not yet implemented");
				break;
			default:
				console.log(`Unhandled action: ${vm.action}`);
		}

		// set output message
		if (workItem != null || workItem != undefined) {
			console.log(`Work item successfully created or updated: ${workItem.id}`);
			core.setOutput(`id`, `${workItem.id}`);
		}
	} catch (error) {
		core.setFailed(error);
	}
}

// create Work Item via https://docs.microsoft.com/en-us/rest/api/azure/devops/
async function create(vm) {
	let patchDocument = [
		{
			op: "add",
			path: "/fields/System.Title",
			value: vm.title + " (GitHub Issue #" + vm.number + ")",
		},
		{
			op: "add",
			path: "/fields/System.Description",
			value: vm.body,
		},
		{
			op: "add",
			path: "/fields/System.Tags",
			value: "GitHub Issue; " + vm.repo_name,
		},
		{
			op: "add",
			path: "/fields/System.History",
			value:
				'GitHub <a href="' +
				vm.url +
				'" target="_new">issue #' +
				vm.number +
				'</a> created in <a href="' +
				vm.repo_url +
				'" target="_new">' +
				vm.repo_fullname +
				"</a>",
		},
		{
			op: "add",
			path: "/relations/-",
			value: {
				rel: "Hyperlink",
				url: vm.url,
			},
		},
	];

	// if area path is not empty, set it
	if (vm.env.areaPath != "") {
		patchDocument.push({
			op: "add",
			path: "/fields/System.AreaPath",
			value: vm.env.areaPath,
		});
	}

	let authHandler = azdev.getPersonalAccessTokenHandler(vm.env.adoToken);
	let connection = new azdev.WebApi(vm.env.orgUrl, authHandler);
	let client = await connection.getWorkItemTrackingApi();
	let workItemSaveResult = null;

	try {
		workItemSaveResult = await client.createWorkItem(
			(customHeaders = []),
			(document = patchDocument),
			(project = vm.env.project),
			(type = vm.env.wit),
			(validateOnly = false),
			(bypassRules = vm.env.bypassRules)
		);

		// if result is null, save did not complete correctly
		if (workItemSaveResult == null) {
			workItemSaveResult = -1;

			console.log("Error: creatWorkItem failed");
			console.log(`WIT may not be correct: ${vm.env.wit}`);
			core.setFailed();
		}

		return workItemSaveResult;
	} catch (error) {
		workItemSaveResult = -1;

		console.log("Error: creatWorkItem failed");
		console.log(patchDocument);
		console.log(error);
		core.setFailed(error);
	}

	return workItemSaveResult;
}

// update existing working item
async function assign(vm, workItem) {

	let patchDocument = [];

	fetch(vm.env.idMappingUrl + vm.assignee, {
		headers: { 
			'Content-Type': 'application/json',
			'api-version': '2019-10-01',
			'Authorization': 'Basic ' + Buffer.from(':' + vm.env.idMappingPat).toString('base64'),
		},
    })
    .then(res => res.json())
	.then(json => {

		var aadUser = jp.value(json, vm.env.idMappingQuery);
		if (aadUser == undefined) {
			console.log("User mapping for " + vm.assignee + " not found.");
			core.setFailed(error.toString());
		}
		// Make changes only if AB issue is unassigned or assigned to a different user.
		if( workItem.fields["System.AssignedTo"] == undefined || aadUser != workItem.fields["System.AssignedTo"].uniqueName )
		{
			patchDocument.push({
				op: "add",
				path: "/fields/System.AssignedTo",
				value: aadUser,
			});
	
			patchDocument.push({
				op: "add",
				path: "/fields/System.History",
				value:
					'Assigned to GitHub user <a href="https://github.com/' +
					+ vm.assignee +
					'" target="_new">' +
					vm.assignee +
					'</a>.',
			});
	
			return updateWorkItem(patchDocument, workItem.id, vm.env);
		}
	})
	.catch(error => {
		console.log("Failed to map user ID.");
		core.setFailed(error);
	});
}

// update existing working item
async function update(vm, workItem) {
	let patchDocument = [];

	if (
		workItem.fields["System.Title"] !=
		`${vm.title} (GitHub Issue #${vm.number})`
	) {
		patchDocument.push({
			op: "add",
			path: "/fields/System.Title",
			value: vm.title + " (GitHub Issue #" + vm.number + ")",
		});
	}

	if (workItem.fields["System.Description"] != vm.body) {
		patchDocument.push({
			op: "add",
			path: "/fields/System.Description",
			value: vm.body,
		});
	}

	if (patchDocument.length > 0) {
		return await updateWorkItem(patchDocument, workItem.id, vm.env);
	} else {
		return null;
	}
}

// add comment to an existing work item
async function comment(vm, workItem) {
	let patchDocument = [];

	if (vm.comment_text != "") {
		patchDocument.push({
			op: "add",
			path: "/fields/System.History",
			value:
				'<a href="' +
				vm.comment_url +
				'" target="_new">GitHub Comment Added</a></br></br>' +
				vm.comment_text,
		});
	}

	if (patchDocument.length > 0) {
		return await updateWorkItem(patchDocument, workItem.id, vm.env);
	} else {
		return null;
	}
}

// close work item
async function close(vm, workItem) {
	let patchDocument = [];

	patchDocument.push({
		op: "add",
		path: "/fields/System.State",
		value: vm.env.closedState,
	});

	if (vm.comment_text != "") {
		patchDocument.push({
			op: "add",
			path: "/fields/System.History",
			value:
				'<a href="' +
				vm.comment_url +
				'" target="_new">GitHub Comment Added</a></br></br>' +
				vm.comment_text,
		});
	}

	if (vm.closed_at != "") {
		patchDocument.push({
			op: "add",
			path: "/fields/System.History",
			value:
				'GitHub <a href="' +
				vm.url +
				'" target="_new">issue #' +
				vm.number +
				"</a> was closed on " +
				vm.closed_at,
		});
	}

	if (patchDocument.length > 0) {
		return await updateWorkItem(patchDocument, workItem.id, vm.env);
	} else {
		return null;
	}
}

// reopen existing work item
async function reopen(vm, workItem) {
	let patchDocument = [];

	patchDocument.push({
		op: "add",
		path: "/fields/System.State",
		value: vm.env.newState,
	});

	patchDocument.push({
		op: "add",
		path: "/fields/System.History",
		value: "Issue reopened",
	});

	if (patchDocument.length > 0) {
		return await updateWorkItem(patchDocument, workItem.id, vm.env);
	} else {
		return null;
	}
}

// add new label to existing work item
async function label(vm, workItem) {
	let patchDocument = [];

	if (!workItem.fields["System.Tags"].includes(vm.label)) {
		patchDocument.push({
			op: "add",
			path: "/fields/System.Tags",
			value: workItem.fields["System.Tags"] + ", " + vm.label,
		});
	}

	if (patchDocument.length > 0) {
		return await updateWorkItem(patchDocument, workItem.id, vm.env);
	} else {
		return null;
	}
}

async function unlabel(vm, workItem) {
	let patchDocument = [];

	if (workItem.fields["System.Tags"].includes(vm.label)) {
		var str = workItem.fields["System.Tags"];
		var res = str.replace(vm.label + "; ", "");

		patchDocument.push({
			op: "add",
			path: "/fields/System.Tags",
			value: res,
		});
	}

	if (patchDocument.length > 0) {
		return await updateWorkItem(patchDocument, workItem.id, vm.env);
	} else {
		return null;
	}
}

// find work item to see if it already exists
async function find(vm) {
	let authHandler = azdev.getPersonalAccessTokenHandler(vm.env.adoToken);
	let connection = new azdev.WebApi(vm.env.orgUrl, authHandler);
	let client = null;
	let workItem = null;
	let queryResult = null;

	try {
		client = await connection.getWorkItemTrackingApi();
	} catch (error) {
		console.log(
			"Error: Connecting to organization. Check the spelling of the organization name and ensure your token is scoped correctly."
		);
		core.setFailed(error);
		return -1;
	}

	let teamContext = { project: vm.env.project };

	let wiql = {
		query:
			"SELECT [System.Id], [System.WorkItemType], [System.Description], [System.Title], [System.AssignedTo], [System.State], [System.Tags] FROM workitems WHERE [System.TeamProject] = @project AND [System.Title] CONTAINS '(GitHub Issue #" +
			vm.number +
			")' AND [System.Tags] CONTAINS 'GitHub Issue' AND [System.Tags] CONTAINS '" +
			vm.repository +
			"'",
	};

	try {
		queryResult = await client.queryByWiql(wiql, teamContext);

		// if query results = null then i think we have issue with the project name
		if (queryResult == null) {
			console.log("Error: Project name appears to be invalid");
			core.setFailed("Error: Project name appears to be invalid");
			return -1;
		}
	} catch (error) {
		console.log("Error: queryByWiql failure");
		console.log(error);
		core.setFailed(error);
		return -1;
	}

	workItem = queryResult.workItems.length > 0 ? queryResult.workItems[0] : null;

	if (workItem != null) {
		try {
			var result = await client.getWorkItem(workItem.id, null, null, 4);
			return result;
		} catch (error) {
			console.log("Error: getWorkItem failure");
			core.setFailed(error);
			return -1;
		}
	} else {
		return null;
	}
}

// standard updateWorkItem call used for all updates
async function updateWorkItem(patchDocument, id, env) {
	let authHandler = azdev.getPersonalAccessTokenHandler(env.adoToken);
	let connection = new azdev.WebApi(env.orgUrl, authHandler);
	let client = await connection.getWorkItemTrackingApi();
	let workItemSaveResult = null;

	try {
		workItemSaveResult = await client.updateWorkItem(
			(customHeaders = []),
			(document = patchDocument),
			(id = id),
			(project = env.project),
			(validateOnly = false),
			(bypassRules = env.bypassRules)
		);

		return workItemSaveResult;
	} catch (error) {
		console.log("Error: updateWorkItem failed");
		console.log(error);
		console.log(patchDocument);
		core.setFailed(error.toString());
	}
}

// update the GH issue body to include the AB# so that we link the Work Item to the Issue
// this should only get called when the issue is created
async function updateIssueBody(vm, workItem) {
	var n = vm.body.includes("AB#" + workItem.id.toString());

	if (!n) {
		const octokit = new github.GitHub(vm.env.ghToken);
		vm.body = vm.body + "\r\n\r\nAB#" + workItem.id.toString();

		var result = await octokit.issues.update({
			owner: vm.owner,
			repo: vm.repository,
			issue_number: vm.number,
			body: vm.body,
		});

		return result;
	}

	return null;
}

// get object values from the payload that will be used for logic, updates, finds, and creates
function getValuesFromPayload(payload, env) {
	// prettier-ignore
	var vm = {
		action: payload.action != undefined ? payload.action : "",
		url: payload.issue.html_url != undefined ? payload.issue.html_url : "",
		number: payload.issue.number != undefined ? payload.issue.number : -1,
		title: payload.issue.title != undefined ? payload.issue.title : "",
		state: payload.issue.state != undefined ? payload.issue.state : "",
		user: payload.issue.user.login != undefined ? payload.issue.user.login : "",
		body: payload.issue.body != undefined ? payload.issue.body : "",
		repo_fullname: payload.repository.full_name != undefined ? payload.repository.full_name : "",
		repo_name: payload.repository.name != undefined ? payload.repository.name : "",
		repo_url: payload.repository.html_url != undefined ? payload.repository.html_url : "",
		closed_at: payload.issue.closed_at != undefined ? payload.issue.closed_at : null,
		owner: payload.repository.owner != undefined ? payload.repository.owner.login : "",
		assignee: payload.assignee != undefined ? payload.assignee.login : "",
		label: "",
		comment_text: "",
		comment_url: "",
		organization: "",
		repository: "",
		env: {
			organization: env.ado_organization != undefined ? env.ado_organization : "",
			orgUrl: env.ado_organization != undefined ? "https://dev.azure.com/" + env.ado_organization : "",
			adoToken: env.ado_token != undefined ? env.ado_token : "",
			ghToken: env.github_token != undefined ? env.github_token : "",
			project: env.ado_project != undefined ? env.ado_project : "",
			areaPath: env.ado_area_path != undefined ? env.ado_area_path : "",
			wit: env.ado_wit != undefined ? env.ado_wit : "Issue",
			closedState: env.ado_close_state != undefined ? env.ado_close_state : "Closed",
			newState: env.ado_new_state != undefined ? env.ado_new_state : "New",
			bypassRules: env.ado_bypassrules != undefined ? env.ado_bypassrules : false,
			idMappingUrl: env.id_mapping_url != undefined ? env.id_mapping_url : "",
			idMappingPat: env.id_mapping_pat != undefined ? env.id_mapping_pat : "",
			idMappingQuery: env.id_mapping_query != undefined ? env.id_mapping_query : ""
		}
	};

	// label is not always part of the payload
	if (payload.label != undefined) {
		vm.label = payload.label.name != undefined ? payload.label.name : "";
	}

	// comments are not always part of the payload
	// prettier-ignore
	if (payload.comment != undefined) {
		vm.comment_text = payload.comment.body != undefined ? payload.comment.body : "";
		vm.comment_url = payload.comment.html_url != undefined ? payload.comment.html_url : "";
	}

	// split repo full name to get the org and repository names
	if (vm.repo_fullname != "") {
		var split = payload.repository.full_name.split("/");
		vm.organization = split[0] != undefined ? split[0] : "";
		vm.repository = split[1] != undefined ? split[1] : "";
	}

	return vm;
}
